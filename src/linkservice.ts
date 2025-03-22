import { Context, Session } from 'koishi'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { MinecraftToolsConfig, ServerConfig } from './index'
import { Rcon } from 'rcon-client'

// 全局状态和类型定义
export type ServerType = 'origin' | 'spigot' | 'forge' | 'neoforge' | 'fabric' | 'velocity' | 'unknown'

// 连接管理 - 多服务器结构
export interface ServerConnection {
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
export const serverConnections = new Map<string, ServerConnection>()

// Minecraft 事件枚举
export enum McEvent {
  '玩家聊天' = 1 << 0,
  '玩家命令' = 1 << 1,
  '玩家死亡' = 1 << 2,
  '玩家加入' = 1 << 3,
  '玩家退出' = 1 << 4,
}

// 事件类型映射表
export const EVENT_TYPE_MAPPING = {
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
export const subTypeToEventMap = Object.entries(EVENT_TYPE_MAPPING).reduce((map, [flag, data]) => {
  map[(data as any).subType] = Number(flag)
  return map
}, {} as Record<string, number>)

export const eventMap = Object.entries(EVENT_TYPE_MAPPING).reduce((map, [_, data]) => {
  const { subType, eventNames } = data as any
  eventNames.forEach(name => map[name] = subType)
  return map
}, {} as Record<string, string>)

// 工具函数
export async function autoRecall(message: string, session?: Session, timeout = 10000): Promise<void> {
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

export function formatTextWithStyles(text: string): any {
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
export function getSubscribedEvents(eventMask: number): string[] {
  return Object.entries(EVENT_TYPE_MAPPING)
    .filter(([bitFlag]) => eventMask & Number(bitFlag))
    .flatMap(([_, data]) => (data as any).eventNames)
}

export function getEventSubType(eventName: string): string {
  return eventMap[eventName] || 'unknown'
}

export function getPlayerName(player: any): string {
  if (!player) return '玩家'
  if (typeof player === 'string') return player
  return player.nickname || player.display_name || player.name || '玩家'
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

export function isChannelInList(session: Session, groups: string[]): boolean {
  if (!groups?.length || !session?.channelId) return false
  const channelKey = `${session.platform}:${session.channelId}`
  return groups.some(channel => channel === channelKey)
}

export function parseWsAddress(address: string): { host: string, port: number } {
  const [host = 'localhost', portStr = '8080'] = address.split(':')
  return { host, port: parseInt(portStr, 10) }
}

export function verifyHeaders(headers: any, token: string): boolean {
  if (!headers.authorization || !headers.authorization.startsWith('Bearer ')) return false
  const authToken = headers.authorization.substring(7)
  return authToken === token && headers['x-self-name'] && headers['x-client-origin']
}

// 辅助函数 - 获取服务器连接
export function getServerConnection(serverId: string): ServerConnection {
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
export function getServerConfig(config: MinecraftToolsConfig, serverId?: string): ServerConfig | null {
  const targetServerId = serverId || config.link.defaultServer
  return config.link.servers.find(server => server.id === targetServerId) || null
}

// 检查服务器连接状态
export function isConnected(serverConn: ServerConnection): boolean {
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

export async function sendRequestAndWaitResponse(api: string, data: any = {}, serverId: string): Promise<any> {
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
export async function sendMinecraftMessage(
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
export function handleIncomingMessage(
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
export function initWebSocketServer(ctx: Context, config: MinecraftToolsConfig, serverConfig: ServerConfig): void {
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
export function initWebSocketClient(ctx: Context, config: MinecraftToolsConfig, serverConfig: ServerConfig): void {
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
