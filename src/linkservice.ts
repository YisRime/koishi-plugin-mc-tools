import { Context, Session } from 'koishi'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { MinecraftToolsConfig } from './index'
import { Rcon } from 'rcon-client'

// 全局状态和类型定义
export type ServerType = 'origin' | 'spigot' | 'forge' | 'neoforge' | 'fabric' | 'velocity' | 'unknown'

interface ServerConnection {
  ws: WebSocket | null
  wss: WebSocketServer | null
  clients: Set<WebSocket>
  reconnectCount: number
  requestIdCounter: number
  pendingRequests: Map<number, {
    resolve: (value: any) => void,
    reject: (reason: any) => void,
    timer: NodeJS.Timeout
  }>
}

// 全局服务器连接对象
export let serverConnection: ServerConnection = {
  ws: null,
  wss: null,
  clients: new Set<WebSocket>(),
  reconnectCount: 0,
  requestIdCounter: 0,
  pendingRequests: new Map()
}

export enum McEvent {
  '玩家聊天' = 1 << 0,
  '玩家命令' = 1 << 1,
  '玩家死亡' = 1 << 2,
  '玩家加入' = 1 << 3,
  '玩家退出' = 1 << 4,
}

// 事件类型映射表
const EVENT_TYPE_MAPPING = {
  [McEvent.玩家聊天]: {
    subType: 'chat',
    eventNames: ['MinecraftPlayerChatEvent', 'AsyncPlayerChatEvent', 'ServerMessageEvent', 'ServerChatEvent', 'NeoServerChatEvent']
  },
  [McEvent.玩家命令]: {
    subType: 'player_command',
    eventNames: ['PlayerCommandPreprocessEvent', 'ServerCommandMessageEvent', 'CommandEvent', 'NeoCommandEvent']
  },
  [McEvent.玩家死亡]: {
    subType: 'death',
    eventNames: ['PlayerDeathEvent', 'ServerLivingEntityAfterDeathEvent', 'NeoPlayerDeathEvent']
  },
  [McEvent.玩家加入]: {
    subType: 'join',
    eventNames: ['MinecraftPlayerJoinEvent', 'PlayerJoinEvent', 'ServerPlayConnectionJoinEvent', 'PlayerLoggedInEvent', 'NeoPlayerLoggedInEvent']
  },
  [McEvent.玩家退出]: {
    subType: 'quit',
    eventNames: ['MinecraftPlayerQuitEvent', 'PlayerQuitEvent', 'ServerPlayConnectionDisconnectEvent', 'PlayerLoggedOutEvent', 'NeoPlayerLoggedOutEvent']
  }
}

// 生成映射表
const subTypeToEventMap = Object.entries(EVENT_TYPE_MAPPING).reduce((map, [flag, data]) => {
  map[(data as any).subType] = Number(flag)
  return map
}, {} as Record<string, number>)

const eventMap = Object.entries(EVENT_TYPE_MAPPING).reduce((map, [_, data]) => {
  const { subType, eventNames } = data as any
  eventNames.forEach(name => map[name] = subType)
  return map
}, {} as Record<string, string>)

// 工具函数
export async function autoRecall(message: string, session?: Session, timeout = 10000): Promise<string> {
  if (!session) return message

  // 确保message是字符串
  const messageStr = typeof message === 'object' ? JSON.stringify(message) : String(message)

  const msgId = await session.send(messageStr)
  if (!msgId) return messageStr
  setTimeout(() => {
    try {
      const ids = Array.isArray(msgId) ? msgId : [msgId]
      ids.forEach(id => session.bot?.deleteMessage(session.channelId, String(id)))
    } catch {}
  }, timeout)
  return messageStr
}

function formatTextWithStyles(text: string): any {
  const regex = /&(\w+)&/
  const match = text.match(regex)
  const output = match ? text.replace(regex, '') : text
  const color = match ? match[1] : ''
  const messageData: any = { text: output, color: color || "white" }

  if (output.match(/\*([^*]+)\*/)) messageData.bold = true
  if (output.match(/_([^_]+)_/)) messageData.italic = true
  if (output.match(/~([^~]+)~/)) messageData.strikethrough = true
  if (output.match(/__([^_]+)__/)) messageData.underlined = true

  messageData.text = messageData.text
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~([^~]+)~/g, '$1')
    .replace(/__([^_]+)__/g, '$1')

  return { type: "text", data: messageData }
}

export function getPlayerDetails(player: any, serverType: ServerType = 'unknown'): Record<string, any> {
  if (!player || typeof player === 'string') return {}

  const details: Record<string, any> = {}
  // 通用属性
  const commonProps = ['nickname', 'uuid', 'level']
  commonProps.forEach(prop => {
    if (player[prop] !== undefined) details[prop] = player[prop]
  })

  // 根据服务端类型处理特定属性
  switch (serverType) {
    case 'spigot':
      const spigotProps = ['is_op', 'exp', 'ping', 'is_flying', 'is_sneaking']
      spigotProps.forEach(prop => {
        if (player[prop] !== undefined && (prop !== 'ping' || player[prop] >= 0)) {
          details[prop] = player[prop]
        }
      })
      break;

    case 'fabric':
      if (player.ip) details.ip = player.ip
      if (player.block_x !== undefined) {
        details.location = `${player.block_x}, ${player.block_y}, ${player.block_z}`
      }
      if (player.is_creative !== undefined) details.gamemode = player.is_creative ? '创造模式' : '生存模式'
      if (player.is_spectator !== undefined && player.is_spectator) details.gamemode = '旁观模式'
      if (player.movement_speed !== undefined) details.speed = player.movement_speed
      break;

    case 'forge':
    case 'neoforge':
      if (player.ipAddress) details.ip = player.ipAddress
      if (player.speed !== undefined) details.speed = player.speed
      if (player.block_x !== undefined) {
        details.location = `${player.block_x}, ${player.block_y}, ${player.block_z}`
      }
      if (player.game_mode) {
        const gameModeMap = {
          'survival': '生存模式', 'creative': '创造模式',
          'adventure': '冒险模式', 'spectator': '旁观模式'
        }
        details.gamemode = gameModeMap[player.game_mode] || player.game_mode
      }

      const statuses = ['is_flying', 'is_swimming', 'is_sleeping', 'is_blocking']
                        .filter(status => player[status])
                        .map(status => status.replace('is_', ''))
      if (statuses.length > 0) {
        details.status = statuses.map(s => {
          const statusMap = { 'flying': '飞行', 'swimming': '游泳', 'sleeping': '睡觉', 'blocking': '格挡' }
          return statusMap[s] || s
        }).join('/')
      }
      break;
  }

  return details
}

// 连接管理
export function sendWebSocketMessage(message: string): void {
  if (serverConnection.ws && serverConnection.ws.readyState === WebSocket.OPEN) {
    serverConnection.ws.send(message)
    return
  }

  serverConnection.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

export async function sendRequestAndWaitResponse(api: string, data: any = {}): Promise<any> {
  const requestId = ++serverConnection.requestIdCounter

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serverConnection.pendingRequests.delete(requestId)
      reject(new Error('请求超时'))
    }, 10000)

    serverConnection.pendingRequests.set(requestId, { resolve, reject, timer })

    try {
      sendWebSocketMessage(JSON.stringify({ api, data, request_id: requestId }))
    } catch (err) {
      clearTimeout(timer)
      serverConnection.pendingRequests.delete(requestId)
      reject(err)
    }
  })
}

export function cleanupWebSocket(): void {
  if (serverConnection.ws) {
    try { serverConnection.ws.terminate() } catch {}
    serverConnection.ws = null
  }
  if (serverConnection.wss) {
    try { serverConnection.wss.close() } catch {}
    serverConnection.wss = null
  }
  serverConnection.clients.clear()

  // 重置服务器连接
  serverConnection = {
    ws: null,
    wss: null,
    clients: new Set<WebSocket>(),
    reconnectCount: 0,
    requestIdCounter: 0,
    pendingRequests: new Map()
  }
}

// 消息处理
export async function sendMinecraftMessage(
  type: string,
  params: any = {},
  successHint?: string
): Promise<string> {
  const isConnected = (serverConnection.ws && serverConnection.ws.readyState === WebSocket.OPEN) ||
    serverConnection.clients.size > 0;

  if (!isConnected) {
    return `未连接到 Minecraft 服务器`
  }

  const apiData = {api: '', data: {}} as any

  try {
    switch (type) {
      case 'text':
        apiData.api = 'broadcast'
        apiData.data.message = Array.isArray(params.message) ?
          params.message : [formatTextWithStyles(params.message)]
        break
      case 'private':
        apiData.api = 'send_private_msg'
        apiData.data.nickname = params.player
        apiData.data.message = Array.isArray(params.message) ?
          params.message : [formatTextWithStyles(params.message)]
        break
      case 'title':
        apiData.api = 'send_title'
        apiData.data.title = Array.isArray(params.title) ?
          params.title : [formatTextWithStyles(params.title)]
        apiData.data.fadein = params.fadein ?? 20
        apiData.data.stay = params.stay ?? 60
        apiData.data.fadeout = params.fadeout ?? 20
        if (params.subtitle) {
          apiData.data.subtitle = Array.isArray(params.subtitle) ?
            params.subtitle : [formatTextWithStyles(params.subtitle)]
        }
        break
      case 'actionbar':
        apiData.api = 'send_actionbar'
        apiData.data.message = Array.isArray(params.message) ?
          params.message : [formatTextWithStyles(params.message)]
        break
      default:
        return `未知消息类型: ${type}`
    }

    const response = await sendRequestAndWaitResponse(apiData.api, apiData.data)

    if (type === 'private' && response.message && response.message.includes('不在线')) {
      return `消息发送失败: ${response.message}`
    }

    return successHint || '消息发送成功'
  } catch (error) {
    return `消息发送失败: ${error.message}`
  }
}

export async function executeRconCommand(
  command: string,
  config: MinecraftToolsConfig,
  session?: Session
): Promise<string> {
  if (!command) return '请输入要执行的命令'

  // 确保RCON已启用
  if (!config.link.enableRcon) {
    return `RCON未启用，无法执行命令`
  }

  // 确保RCON密码存在
  if (!config.link.rcon.password) {
    return `未设置RCON密码，无法执行命令`
  }

  const [serverHost, portStr] = config.link.rcon.address.split(':')
  const port = parseInt(portStr)

  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.link.rcon.password
    })

    const result = await rcon.send(command)
    await rcon.end()

    if (session) {
      return await autoRecall(`[${config.link.name}] 命令执行成功${result}`, session)
    }
    return `[${config.link.name}] 命令执行成功${result}`
  } catch (error) {
    const errorMsg = `[${config.link.name}] RCON连接失败: ${error.message}`
    if (session) {
      return await autoRecall(errorMsg, session)
    }
    return errorMsg
  }
}

// WebSocket 通信
function handleIncomingMessage(
  ctx: Context,
  config: MinecraftToolsConfig,
  message: string
): void {
  try {
    const data = JSON.parse(message)

    // 处理API错误响应
    if (data.status === 'error' && data.api) {
      ctx.logger.warn(`[${config.link.name}] API错误: ${data.api} - ${data.message || '未知错误'}`)
    }

    // 处理请求响应
    if (data.request_id && serverConnection.pendingRequests.has(data.request_id)) {
      const pendingRequest = serverConnection.pendingRequests.get(data.request_id)
      if (pendingRequest) {
        clearTimeout(pendingRequest.timer)
        serverConnection.pendingRequests.delete(data.request_id)
        data.status === 'ok' ? pendingRequest.resolve(data) : pendingRequest.reject(new Error(data.message || '请求处理失败'))
        return
      }
    }

    // 非事件消息
    if (!data.post_type && !data.event_name) return

    // 处理事件类型
    const subType = data.sub_type || (eventMap[data.event_name || ''] || 'unknown')

    // 检查订阅
    const eventFlag = subTypeToEventMap[subType]
    if (!eventFlag || !(config.link.events & eventFlag)) return

    const playerName = data.player.nickname || data.player.display_name || data.player.name
    // 格式化消息
    let formattedMsg = ''
    const serverDisplayName = data.server_name || config.link.name

    switch (subType) {
      case 'chat':
        formattedMsg = `[${serverDisplayName}] <${playerName}> ${data.message}`
        break
      case 'player_command':
        formattedMsg = `[${serverDisplayName}] ${playerName} 执行命令: ${data.message}`
        break
      case 'death':
        formattedMsg = `[${serverDisplayName}] ${data.message || `${playerName} 死亡了`}`
        break
      case 'join':
        formattedMsg = `[${serverDisplayName}] ${playerName} 加入了游戏`
        break
      case 'quit':
        formattedMsg = `[${serverDisplayName}] ${playerName} 退出了游戏`
        break
      default:
        return
    }

    // 转发消息到该服务器的专属群组
    if (config.link.group) {
      const [platform, id] = config.link.group.split(':', 2)
      ctx.bots.forEach(bot => {
        if (bot.platform === platform) {
          bot.sendMessage(id, formattedMsg)
        }
      })
    }
  } catch (error) {
    ctx.logger.error(`处理接收消息出错: ${error.message}`)
  }
}

export function initWebSocketServer(ctx: Context, config: MinecraftToolsConfig): void {
  if (!config.link.enableWebSocket || !config.link.websocket.token) return

  const [host, portStr] = config.link.websocket.address.split(':')
  const port = parseInt(portStr, 10)

  serverConnection.wss = new WebSocketServer({ host, port })
  serverConnection.wss.on('connection', (ws, req) => {
    const headers = {
      authorization: req.headers.authorization as string,
      'x-self-name': req.headers['x-self-name'] as string,
      'x-client-origin': req.headers['x-client-origin'] as string
    }

    if (!(
      headers.authorization &&
      headers.authorization.startsWith('Bearer ') &&
      headers.authorization.substring(7) === config.link.websocket.token &&
      headers['x-self-name'] &&
      headers['x-client-origin']
    )) {
      ws.close(1008, 'Invalid header!')
      return
    }

    ctx.logger.info(`[${config.link.name}] 客户端连接成功: ${headers['x-self-name']} (${req.socket.remoteAddress})`)
    serverConnection.clients.add(ws)

    ws.on('message', (data) => handleIncomingMessage(ctx, config, data.toString()))
    ws.on('close', () => {
      ctx.logger.info(`[${config.link.name}] 客户端连接关闭: ${headers['x-self-name']}`)
      serverConnection.clients.delete(ws)
    })
    ws.on('error', (error) => {
      ctx.logger.error(`[${config.link.name}] WebSocket 服务器错误: ${error.message}`)
      serverConnection.clients.delete(ws)
    })
  })

  serverConnection.wss.on('error', (error) => ctx.logger.error(`[${config.link.name}] WebSocket 服务器错误: ${error.message}`))
}

export function initWebSocketClient(ctx: Context, config: MinecraftToolsConfig): void {
  if (!config.link.enableWebSocket || !config.link.websocket.token) return

  const [host, portStr] = config.link.websocket.address.split(':')
  const port = parseInt(portStr, 10)

  serverConnection.ws = new WebSocket(`ws://${host}:${port}/minecraft/ws`, {
    headers: {
      "x-self-name": config.link.name,
      "Authorization": `Bearer ${config.link.websocket.token}`,
      "x-client-origin": "koishi"
    }
  })

  serverConnection.ws.on('open', () => {
    ctx.logger.info(`[${config.link.name}] WebSocket 客户端连接成功`)
    serverConnection.reconnectCount = 0
  })

  serverConnection.ws.on('message', (data) => handleIncomingMessage(ctx, config, data.toString()))
  serverConnection.ws.on('error', (error) => ctx.logger.error(`[${config.link.name}] WebSocket 客户端错误: ${error.message}`))

  serverConnection.ws.on('close', (code, reason) => {
    ctx.logger.warn(`[${config.link.name}] WebSocket 客户端连接关闭: ${code} ${reason.toString()}`)
    serverConnection.ws = null

    if (serverConnection.reconnectCount < 3) {
      serverConnection.reconnectCount++
      setTimeout(() => initWebSocketClient(ctx, config), 20000)
    } else {
      ctx.logger.error(`[${config.link.name}] WebSocket 连接失败`)
    }
  })
}

export function initWebSocketCommunication(ctx: Context, config: MinecraftToolsConfig): void {
  // 如果WebSocket未启用，则不初始化
  if (!config.link.enableWebSocket) return

  // 清理旧连接
  cleanupWebSocket()

  // 没有配置token则不初始化
  if (!config.link.websocket.token) return

  // 根据模式初始化不同类型的连接
  if (config.link.websocket.mode === 'client') {
    initWebSocketClient(ctx, config)
  } else {
    initWebSocketServer(ctx, config)
  }

  // 处理消息转发到Minecraft
  ctx.on('message', (session) => {
    // 如果是命令，则不转发
    if (session.content.startsWith('/') || session.content.startsWith('.')) {
      return
    }

    const regex = /&(\w+)&/
    const match = session.content.match(regex)
    const output = match ? session.content.replace(regex, '') : session.content
    const color = match ? match[1] : ''

    // 检查这条消息是否应该转发到服务器
    if (!config.link.enableWebSocket || !config.link.websocket.token) return
    // 检查会话是否在指定群组中
    if (!session?.channelId) return
    const channelKey = `${session.platform}:${session.channelId}`
    if (channelKey !== config.link.group) return

    const isConnected = (serverConnection.ws && serverConnection.ws.readyState === WebSocket.OPEN) ||
                        serverConnection.clients.size > 0;
    if (!isConnected) return

    const msgData = {
      api: "send_msg",
      data: {
        message: {
          type: "text",
          data: {
            text: `(${session.platform})[${session.username || session.userId}] ${output}`,
            color: color || "white"
          }
        }
      }
    }

    // 检测并处理图片链接
    const imageMatch = session.content.match(/(https?|file):\/\/.*?\.(jpg|jpeg|webp|ico|gif|jfif|bmp|png)/i)
    if (imageMatch) {
      const sendImage = imageMatch[0]
      msgData.data.message.data.text = msgData.data.message.data.text.replace(sendImage, `<img src="${sendImage}" />`)
    }
    sendWebSocketMessage(JSON.stringify(msgData))
  })
}
