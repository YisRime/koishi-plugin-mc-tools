import { Context, Session } from 'koishi'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { MinecraftToolsConfig, ServerConfig } from './index'
import { Rcon } from 'rcon-client'

// 全局状态和类型定义
type ServerType = 'origin' | 'spigot' | 'forge' | 'neoforge' | 'fabric' | 'velocity' | 'unknown'

// 连接管理 - 修改为多服务器结构
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

// 服务器连接映射
const serverConnections = new Map<string, ServerConnection>()

// Minecraft 事件枚举
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
async function autoRecall(message: string, session?: Session, timeout = 10000): Promise<void> {
  if (!session) return
  const msgId = await session.send(message)
  if (!msgId) return
  setTimeout(() => {
    try {
      const ids = Array.isArray(msgId) ? msgId : [msgId]
      ids.forEach(id => session.bot?.deleteMessage(session.channelId, String(id)))
    } catch {}
  }, timeout)
}

export function extractAndRemoveColor(input: string): { output: string, color: string } {
  const regex = /&(\w+)&/
  const match = input.match(regex)
  return match ? { output: input.replace(regex, ''), color: match[1] } : { output: input, color: '' }
}

function formatTextWithStyles(text: string): any {
  const { output, color } = extractAndRemoveColor(text)
  const messageData: any = { text: output, color: color || "white" }
  // 处理样式标记
  if (output.match(/\*([^*]+)\*/)) messageData.bold = true
  if (output.match(/_([^_]+)_/)) messageData.italic = true
  if (output.match(/~([^~]+)~/)) messageData.strikethrough = true
  if (output.match(/__([^_]+)__/)) messageData.underlined = true
  // 移除样式标记
  messageData.text = messageData.text
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~([^~]+)~/g, '$1')
    .replace(/__([^_]+)__/g, '$1')

  return { type: "text", data: messageData }
}

// 辅助函数
function getSubscribedEvents(eventMask: number): string[] {
  return Object.entries(EVENT_TYPE_MAPPING)
    .filter(([bitFlag]) => eventMask & Number(bitFlag))
    .flatMap(([_, data]) => (data as any).eventNames)
}

function getEventSubType(eventName: string): string {
  return eventMap[eventName] || 'unknown'
}

function getPlayerName(player: any): string {
  if (!player) return '玩家'
  if (typeof player === 'string') return player
  return player.nickname || player.display_name || player.name || '玩家'
}

function getPlayerDetails(player: any, serverType: ServerType = 'unknown'): Record<string, any> {
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

function isChannelInList(session: Session, groups: string[]): boolean {
  if (!groups?.length || !session?.channelId) return false
  const channelKey = `${session.platform}:${session.channelId}`
  return groups.some(channel => channel === channelKey)
}

function parseWsAddress(address: string): { host: string, port: number } {
  const [host = 'localhost', portStr = '8080'] = address.split(':')
  return { host, port: parseInt(portStr, 10) }
}

function verifyHeaders(headers: any, token: string): boolean {
  if (!headers.authorization || !headers.authorization.startsWith('Bearer ')) return false
  const authToken = headers.authorization.substring(7)
  return authToken === token && headers['x-self-name'] && headers['x-client-origin']
}

// 辅助函数 - 获取服务器连接
function getServerConnection(serverId: string): ServerConnection {
  if (!serverConnections.has(serverId)) {
    serverConnections.set(serverId, {
      ws: null,
      wss: null,
      clients: new Set<WebSocket>(),
      reconnectCount: 0,
      requestIdCounter: 0,
      pendingRequests: new Map()
    })
  }
  return serverConnections.get(serverId)
}

// 辅助函数 - 获取指定服务器配置
function getServerConfig(config: MinecraftToolsConfig, serverId?: string): ServerConfig | null {
  const targetServerId = serverId || config.link.defaultServer
  return config.link.servers.find(server => server.id === targetServerId) || null
}

// 检查服务器连接状态
function isConnected(serverConn: ServerConnection): boolean {
  return !!(
    (serverConn.ws && serverConn.ws.readyState === WebSocket.OPEN) ||
    serverConn.clients.size > 0
  )
}

// WebSocket通信
export function sendWebSocketMessage(message: string, serverId: string): void {
  const serverConn = serverConnections.get(serverId)
  if (!serverConn) return

  if (serverConn.ws && serverConn.ws.readyState === WebSocket.OPEN) {
    serverConn.ws.send(message)
    return
  }

  serverConn.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

async function sendRequestAndWaitResponse(api: string, data: any = {}, serverId: string): Promise<any> {
  const serverConn = serverConnections.get(serverId)
  if (!serverConn) {
    throw new Error(`服务器 ${serverId} 未初始化连接`)
  }

  const requestId = ++serverConn.requestIdCounter

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serverConn.pendingRequests.delete(requestId)
      reject(new Error('请求超时'))
    }, 10000)

    serverConn.pendingRequests.set(requestId, { resolve, reject, timer })

    try {
      sendWebSocketMessage(JSON.stringify({ api, data, request_id: requestId }), serverId)
    } catch (err) {
      clearTimeout(timer)
      serverConn.pendingRequests.delete(requestId)
      reject(err)
    }
  })
}

// 清理WebSocket连接
export function cleanupWebSocket(serverId?: string): void {
  if (serverId) {
    // 清理指定服务器连接
    const serverConn = serverConnections.get(serverId)
    if (serverConn) {
      if (serverConn.ws) {
        try { serverConn.ws.terminate() } catch {}
        serverConn.ws = null
      }
      if (serverConn.wss) {
        try { serverConn.wss.close() } catch {}
        serverConn.wss = null
      }
      serverConn.clients.clear()
    }
  } else {
    // 清理所有服务器连接
    for (const [, conn] of serverConnections.entries()) {
      if (conn.ws) {
        try { conn.ws.terminate() } catch {}
        conn.ws = null
      }
      if (conn.wss) {
        try { conn.wss.close() } catch {}
        conn.wss = null
      }
      conn.clients.clear()
    }
    serverConnections.clear()
  }
}

// 消息发送
async function sendMinecraftMessage(
  type: string,
  params: any = {},
  serverId: string,
  successHint?: string
): Promise<string> {
  const serverConn = serverConnections.get(serverId)
  if (!serverConn || !isConnected(serverConn)) {
    return `未连接到服务器 ${serverId}，请检查连接状态。`
  }

  const apiData = {api: '', data: {}} as any

  try {
    switch (type) {
      case 'text':
        apiData.api = 'send_msg'
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
        return `未知的消息类型: ${type}`
    }

    const response = await sendRequestAndWaitResponse(apiData.api, apiData.data, serverId)

    if (type === 'private' && response.message && response.message.includes('不在线')) {
      return `消息发送失败: ${response.message}`
    }

    return successHint || '消息发送成功'
  } catch (error) {
    return `消息发送失败: ${error.message}`
  }
}

// RCON 执行命令
export async function executeRconCommand(
  command: string,
  config: MinecraftToolsConfig,
  session?: Session,
  serverId?: string
): Promise<void> {
  if (!command) return autoRecall('请输入要执行的命令', session)

  const serverConfig = getServerConfig(config, serverId)
  if (!serverConfig) return autoRecall(`找不到服务器配置: ${serverId || '默认'}`, session)

  if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
    return autoRecall(`服务器 ${serverConfig.name} 未启用RCON或未配置密码`, session)
  }

  const [serverHost, portStr] = serverConfig.rcon.address.split(':')
  const port = portStr ? parseInt(portStr) : 25575

  if (!serverHost) return autoRecall('请正确配置RCON地址', session)
  if (isNaN(port)) return autoRecall('RCON端口不正确', session)

  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: serverConfig.rcon.password
    })

    const result = await rcon.send(command)
    await rcon.end()

    return autoRecall(`[${serverConfig.name}] 命令执行成功${result}`, session)
  } catch (error) {
    return autoRecall(`[${serverConfig.name}] RCON连接失败: ${error.message}`, session)
  }
}

// WebSocket消息处理
function handleIncomingMessage(
  ctx: Context,
  config: MinecraftToolsConfig,
  message: string,
  serverId: string
): void {
  try {
    const serverConn = serverConnections.get(serverId)
    if (!serverConn) return

    const serverConfig = getServerConfig(config, serverId)
    if (!serverConfig) return

    const data = JSON.parse(message)

    // 处理请求响应
    if (data.request_id && serverConn.pendingRequests.has(data.request_id)) {
      const pendingRequest = serverConn.pendingRequests.get(data.request_id)
      if (pendingRequest) {
        clearTimeout(pendingRequest.timer)
        serverConn.pendingRequests.delete(data.request_id)
        data.status === 'ok' ? pendingRequest.resolve(data) : pendingRequest.reject(new Error(data.message || '请求处理失败'))
        return
      }
    }

    // 非事件消息
    if (!data.post_type && !data.event_name) return

    // 处理事件类型
    const subType = data.sub_type || getEventSubType(data.event_name || '')

    // 检查订阅
    const eventFlag = subTypeToEventMap[subType]
    if (!eventFlag || !(config.link.events & eventFlag)) return

    // 获取玩家名称
    const playerName = getPlayerName(data.player)

    // 格式化消息
    let formattedMsg = ''
    const serverName = data.server_name || serverConfig.name

    switch (subType) {
      case 'chat':
        formattedMsg = `[${serverName}] <${playerName}> ${data.message || ''}`
        break
      case 'player_command':
        formattedMsg = `[${serverName}] ${playerName} 执行命令: ${data.message || ''}`
        break
      case 'death':
        formattedMsg = `[${serverName}] ${data.message || `${playerName} 死亡了`}`
        break
      case 'join':
        formattedMsg = `[${serverName}] ${playerName} 加入了游戏`
        break
      case 'quit':
        formattedMsg = `[${serverName}] ${playerName} 退出了游戏`
        break
      default:
        return
    }

    // 转发消息到群组
    config.link.groups.forEach(channelId => {
      const [platform, id] = channelId.split(':', 2)
      if (!platform || !id) return
      ctx.bots.forEach(bot => {
        if (bot.platform === platform) {
          bot.sendMessage(id, formattedMsg)
        }
      })
    })
  } catch (error) {
    ctx.logger.error(`处理接收消息出错: ${error.message}`)
  }
}

// WebSocket服务端初始化
function initWebSocketServer(ctx: Context, config: MinecraftToolsConfig, serverConfig: ServerConfig): void {
  if (!serverConfig.websocket.enabled || !serverConfig.websocket.token) return

  const serverId = serverConfig.id
  const serverConn = getServerConnection(serverId)

  const { address } = serverConfig.websocket
  const { host, port } = parseWsAddress(address)

  serverConn.wss = new WebSocketServer({ host, port })
  ctx.logger.info(`[${serverConfig.name}] WebSocket 服务器启动 ws://${host}:${port}`)

  serverConn.wss.on('connection', (ws, req) => {
    const headers = {
      authorization: req.headers.authorization as string || '',
      'x-self-name': req.headers['x-self-name'] as string || '',
      'x-client-origin': req.headers['x-client-origin'] as string || ''
    }

    if (!verifyHeaders(headers, serverConfig.websocket.token)) {
      ws.close(1008, 'Invalid header!')
      return
    }

    ctx.logger.info(`[${serverConfig.name}] 新的客户端连接: ${headers['x-self-name']} (${req.socket.remoteAddress})`)
    serverConn.clients.add(ws)

    ws.send(JSON.stringify({
      api: "subscribe_events",
      data: { events: getSubscribedEvents(config.link.events) }
    }))

    ws.on('message', (data) => handleIncomingMessage(ctx, config, data.toString(), serverId))
    ws.on('close', () => {
      ctx.logger.info(`[${serverConfig.name}] 客户端断开连接: ${headers['x-self-name']}`)
      serverConn.clients.delete(ws)
    })
    ws.on('error', (error) => {
      ctx.logger.error(`[${serverConfig.name}] WebSocket 服务器错误: ${error.message}`)
      serverConn.clients.delete(ws)
    })
  })

  serverConn.wss.on('error', (error) => ctx.logger.error(`[${serverConfig.name}] WebSocket 服务器错误: ${error.message}`))
}

// WebSocket客户端初始化
function initWebSocketClient(ctx: Context, config: MinecraftToolsConfig, serverConfig: ServerConfig): void {
  if (!serverConfig.websocket.enabled || !serverConfig.websocket.token) return

  const serverId = serverConfig.id
  const serverConn = getServerConnection(serverId)

  const { address } = serverConfig.websocket
  const { host, port } = parseWsAddress(address)

  serverConn.ws = new WebSocket(`ws://${host}:${port}/minecraft/ws`, {
    headers: {
      "x-self-name": serverConfig.name,
      "Authorization": `Bearer ${serverConfig.websocket.token}`,
      "x-client-origin": "koishi"
    }
  })

  serverConn.ws.on('open', () => {
    ctx.logger.info(`[${serverConfig.name}] WebSocket 客户端连接成功`)
    serverConn.reconnectCount = 0

    serverConn.ws.send(JSON.stringify({
      api: "subscribe_events",
      data: { events: getSubscribedEvents(config.link.events) }
    }))
  })

  serverConn.ws.on('message', (data) => handleIncomingMessage(ctx, config, data.toString(), serverId))
  serverConn.ws.on('error', (error) => ctx.logger.error(`[${serverConfig.name}] WebSocket 客户端错误: ${error.message}`))
  serverConn.ws.on('close', (code, reason) => {
    ctx.logger.warn(`[${serverConfig.name}] WebSocket 客户端连接关闭: ${code} ${reason.toString()}`)
    serverConn.ws = null

    if (serverConn.reconnectCount < 3) {
      serverConn.reconnectCount++
      setTimeout(() => initWebSocketClient(ctx, config, serverConfig), 20000)
    } else {
      ctx.logger.error(`[${serverConfig.name}] WebSocket 连接失败`)
    }
  })
}

// 初始化WebSocket通信
export function initWebSocketCommunication(ctx: Context, config: MinecraftToolsConfig): void {
  // 清理旧连接
  cleanupWebSocket()

  // 为每个配置的服务器初始化连接
  config.link.servers.forEach(serverConfig => {
    if (!serverConfig.websocket.enabled || !serverConfig.websocket.token) return

    // 根据模式初始化不同类型的连接
    if (serverConfig.websocket.mode === 'client') {
      initWebSocketClient(ctx, config, serverConfig)
    } else {
      initWebSocketServer(ctx, config, serverConfig)
    }
  })

  // 处理消息转发到Minecraft
  ctx.on('message', (session) => {
    if (!isChannelInList(session, config.link.groups) ||
        session.content.startsWith('/') ||
        session.content.startsWith('.')) {
      return
    }

    const { output, color } = extractAndRemoveColor(session.content)
    // 发送到所有启用了WebSocket的服务器
    config.link.servers.forEach(serverConfig => {
      if (!serverConfig.websocket.enabled) return
      const serverId = serverConfig.id
      const serverConn = serverConnections.get(serverId)
      if (!serverConn || !isConnected(serverConn)) return

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

      sendWebSocketMessage(JSON.stringify(msgData), serverId)
    })
  })
}

// 命令注册
export function registerServerCommands(parent: any, config: MinecraftToolsConfig, ctx: Context) {
  // 主命令
  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .action(async ({ session }) => {
      const statusMessage = ['Minecraft 服务器状态:']

      if (config.link.servers.length === 0) {
        return autoRecall('未配置任何服务器', session)
      }

      statusMessage.push(`默认服务器: ${config.link.defaultServer || '未设置'}`)
      statusMessage.push('\n可用服务器列表:')

      config.link.servers.forEach(server => {
        const serverConn = serverConnections.get(server.id)
        const rconStatus = server.rcon.enabled ? '已启用' : '未启用'
        const wsStatus = server.websocket.enabled ?
          (serverConn && isConnected(serverConn) ? '已连接' : '未连接') : '未启用'

        statusMessage.push(`- ${server.name} (${server.id})`)
        statusMessage.push(`  RCON: ${rconStatus} (${server.rcon.address})`)
        statusMessage.push(`  WebSocket: ${wsStatus} (${server.websocket.mode}模式, ${server.websocket.address})`)
      })

      if (config.link.groups.length > 0) {
        statusMessage.push(`\n消息转发群组: ${config.link.groups.join(', ')}`)
      }

      // 尝试重连未连接的WebSocket
      config.link.servers.forEach(server => {
        if (!server.websocket.enabled || !server.websocket.token) return

        const serverConn = serverConnections.get(server.id)
        if (!serverConn || !isConnected(serverConn)) {
          statusMessage.push(`\n正在自动重新连接 ${server.name} 的WebSocket...`)
          cleanupWebSocket(server.id)

          if (server.websocket.mode === 'client') {
            initWebSocketClient(ctx, config, server)
          } else {
            initWebSocketServer(ctx, config, server)
          }
        }
      })

      return autoRecall(statusMessage.join('\n'), session)
    })

  // 检查群组权限
  const checkGroupPermission = ({ session }) => {
    if (!isChannelInList(session, config.link.groups)) {
      return autoRecall('此群组没有权限执行服务器命令', session)
    }
  }

  // 检查服务器存在
  const getTargetServerId = (options): string => {
    if (options.server) {
      const exists = config.link.servers.some(s => s.id === options.server)
      if (!exists) {
        throw new Error(`服务器 ${options.server} 不存在`)
      }
      return options.server
    }
    return config.link.defaultServer
  }

  // 消息发送命令
  mcserver.subcommand('.say <message:text>', '发送消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, message) => {
      if (!message) return autoRecall('请输入要发送的消息', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await sendMinecraftMessage('text', { message }, serverId)
          return autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          const userIdentifier = session.username || session.userId
          return executeRconCommand(`say ${userIdentifier}: ${message}`, config, session, serverId)
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  mcserver.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, player, message) => {
      if (!player || !message) return autoRecall('用法: mc.server.tell <玩家名> <消息>', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await sendMinecraftMessage('private', { player, message }, serverId, `向玩家 ${player} 发送消息成功`)
          return autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          const userIdentifier = session.username || session.userId
          return executeRconCommand(`tell ${player} ${userIdentifier}: ${message}`, config, session, serverId)
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 标题和动作栏命令
  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-s <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .before(checkGroupPermission)
    .action(async ({ options, session }, title, subtitle = '') => {
      if (!title) return autoRecall('请输入要发送的标题', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await sendMinecraftMessage('title', {
            title,
            subtitle,
            fadein: options.fadein * 20,
            stay: options.stay * 20,
            fadeout: options.fadeout * 20
          }, serverId)
          return autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          // 使用RCON执行
          let cmd = `title @a title {"text":"${title}"}`
          await executeRconCommand(cmd, config, session, serverId)

          if (subtitle) {
            cmd = `title @a subtitle {"text":"${subtitle}"}`
            await executeRconCommand(cmd, config, session, serverId)
          }

          cmd = `title @a times ${options.fadein * 20} ${options.stay * 20} ${options.fadeout * 20}`
          return executeRconCommand(cmd, config, session, serverId)
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, message) => {
      if (!message) return autoRecall('请输入要发送的消息', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await sendMinecraftMessage('actionbar', { message }, serverId)
          return autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          const cmd = `title @a actionbar {"text":"${message}"}`
          return executeRconCommand(cmd, config, session, serverId)
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 玩家信息查询命令
  mcserver.subcommand('.player', '获取服务器在线玩家信息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }) => {
      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          try {
            await session.send(`正在获取 ${serverConfig.name} 的玩家信息...`)
            const response = await sendRequestAndWaitResponse('get_players', {}, serverId)

            if (!response.data || !response.data.players) {
              return autoRecall('没有获取到玩家信息或服务器返回数据格式错误。', session)
            }

            const { players, server_name = serverConfig.name, server_type = 'unknown', max_players = '?' } = response.data

            if (players.length === 0) {
              return autoRecall(`[${server_name}] 当前没有在线玩家`, session)
            }

            let message = `[${server_name}] 在线玩家(${players.length}/${max_players}):\n`

            message += players.map((player: any) => {
              const name = getPlayerName(player)
              const details = getPlayerDetails(player, server_type as ServerType)

              const extras = []
              if (details.level) extras.push(`等级: ${details.level}`)
              if (details.ping !== undefined) extras.push(`延迟: ${details.ping}ms`)
              if (details.gamemode) extras.push(details.gamemode)
              if (details.status) extras.push(details.status)
              if (details.is_flying && !details.status) extras.push('飞行中')
              if (details.is_sneaking && !details.status) extras.push('潜行中')
              if (details.location) extras.push(`坐标: ${details.location}`)

              return extras.length > 0 ? `${name} (${extras.join(', ')})` : name
            }).join('\n')

            return autoRecall(message, session)
          } catch (error) {
            // WebSocket请求失败，尝试RCON
            if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
              return executeRconCommand('list', config, session, serverId)
            }
            return autoRecall(`获取信息失败: ${error.message}`, session)
          }
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          return executeRconCommand('list', config, session, serverId)
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 广播消息命令
  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, message) => {
      if (!message) return autoRecall('请输入要广播的消息', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await sendMinecraftMessage('text', { message }, serverId)
          return autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          return executeRconCommand(`say ${message}`, config, session, serverId)
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 服务器状态
  mcserver.subcommand('.status', '查看服务器状态')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }) => {
      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          try {
            const response = await sendRequestAndWaitResponse('get_server_status', {}, serverId)

            if (!response.data) {
              if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
                return executeRconCommand('list', config, session, serverId)
              }
              return autoRecall('无法获取服务器状态信息', session)
            }

            const {
              server_name = serverConfig.name,
              version = '未知',
              online_players = 0,
              max_players = '?',
              tps = '未知',
              memory_used,
              memory_total,
              uptime
            } = response.data;

            const memUsed = memory_used ? `${(memory_used / 1024 / 1024).toFixed(2)}MB` : '未知'
            const memTotal = memory_total ? `${(memory_total / 1024 / 1024).toFixed(2)}MB` : '未知'
            const upStr = uptime ? `${Math.floor(uptime / 3600)}小时${Math.floor((uptime % 3600) / 60)}分钟` : '未知'

            const statusLines = [
              `[${server_name}] 状态信息:`,
              `版本: ${version}`,
              `在线玩家: ${online_players}/${max_players}`,
              `TPS: ${tps}`,
              `内存使用: ${memUsed}/${memTotal}`,
              `已运行: ${upStr}`
            ]

            return autoRecall(statusLines.join('\n'), session)
          } catch (error) {
            if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
              return executeRconCommand('list', config, session, serverId)
            }
            return autoRecall(`获取服务器状态失败: ${error.message}`, session)
          }
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          try {
            const listPromise = new Promise<string>(async (resolve) => {
              const [host, portStr] = serverConfig.rcon.address.split(':')
              const port = parseInt(portStr) || 25575

              const rcon = await Rcon.connect({
                host,
                port,
                password: serverConfig.rcon.password
              })

              const listResult = await rcon.send('list')
              await rcon.end()
              resolve(listResult)
            })

            const result = await listPromise
            return autoRecall(`[${serverConfig.name}] 状态:\n${result}`, session)
          } catch (error) {
            return autoRecall(`RCON连接失败: ${error.message}`, session)
          }
        } else {
          return autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 服务器管理命令（仅RCON支持）
  mcserver.subcommand('.admin', '服务器管理命令')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(({ session }) => {
      return autoRecall('管理命令用法:\n' +
        '.kick <玩家> [原因] - 踢出玩家\n' +
        '.ban <玩家> [原因] - 封禁玩家\n' +
        '.op <玩家> - 给予管理员权限\n' +
        '.wl [玩家] - 管理白名单\n' +
        '.run <命令> - 执行自定义命令', session)
    })

  // 踢出玩家
  mcserver.subcommand('.kick <player:string> [reason:text]', '踢出玩家', { authority: 2 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, player, reason) => {
      if (!player) return autoRecall('请输入玩家名', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        const cmd = `kick ${player}${reason ? ` ${reason}` : ''}`
        return executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 封禁玩家
  mcserver.subcommand('.ban <player:string> [reason:text]', '封禁玩家', { authority: 3 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('ip', '--ip 封禁IP')
    .before(checkGroupPermission)
    .action(async ({ options, session }, player, reason) => {
      if (!player) return autoRecall('请输入玩家名或IP地址', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        const cmd = `${options.ip ? 'ban-ip' : 'ban'} ${player}${reason ? ` ${reason}` : ''}`
        return executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 管理管理员
  mcserver.subcommand('.op <player:string>', '管理管理员', { authority: 3 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('r', '-r 移除权限')
    .before(checkGroupPermission)
    .action(async ({ options, session }, player) => {
      if (!player) return autoRecall('请输入玩家名', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        const cmd = `${options.r ? 'deop' : 'op'} ${player}`
        return executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 管理白名单
  mcserver.subcommand('.wl [player:string]', '管理白名单', { authority: 2 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('r', '-r 移除玩家')
    .option('on', '--on 开启白名单')
    .option('off', '--off 关闭白名单')
    .before(checkGroupPermission)
    .action(async ({ options, session }, player) => {
      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        let cmd;
        if (options.off) cmd = 'whitelist off'
        else if (options.on) cmd = 'whitelist on'
        else if (options.r) {
          if (!player) return autoRecall('请输入玩家名', session)
          cmd = `whitelist remove ${player}`
        }
        else if (player) cmd = `whitelist add ${player}`
        else cmd = 'whitelist list'

        return executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 执行自定义命令
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, command) => {
      if (!command) return autoRecall('请输入要执行的命令', session)

      if (!config.link.sudoUsers.includes(session?.userId)) {
        return autoRecall('你没有权限执行自定义命令', session)
      }

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = getServerConfig(config, serverId)

        if (!serverConfig) {
          return autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        return executeRconCommand(command, config, session, serverId)
      } catch (error) {
        return autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })
}
