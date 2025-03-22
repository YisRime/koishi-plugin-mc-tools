import { Context, Session } from 'koishi'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { MinecraftToolsConfig } from './index'
import { Rcon } from 'rcon-client'

// 全局状态和类型定义
type ServerType = 'origin' | 'spigot' | 'forge' | 'neoforge' | 'fabric' | 'velocity' | 'unknown'
// WebSocket 连接管理
let globalWs: WebSocket | null = null
let wss: WebSocketServer | null = null
const clients = new Set<WebSocket>()
let reconnectCount = 0
// WebSocket 请求管理
let requestIdCounter = 0
const pendingRequests = new Map<number, {
  resolve: (value: any) => void,
  reject: (reason: any) => void,
  timer: NodeJS.Timeout
}>()
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

// 连接类型检查
function isRconEnabled(config: MinecraftToolsConfig): boolean {
  return ['rcon', 'both'].includes(config.link.connectionType)
}

function isWsEnabled(config: MinecraftToolsConfig): boolean {
  return ['ws', 'both'].includes(config.link.connectionType)
}

// WebSocket通信
export function sendWebSocketMessage(message: string): void {
  if (globalWs && globalWs.readyState === WebSocket.OPEN) {
    globalWs.send(message)
    return
  }

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

async function sendRequestAndWaitResponse(api: string, data: any = {}): Promise<any> {
  const requestId = ++requestIdCounter

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('请求超时'))
    }, 10000)

    pendingRequests.set(requestId, { resolve, reject, timer })

    try {
      sendWebSocketMessage(JSON.stringify({ api, data, request_id: requestId }))
    } catch (err) {
      clearTimeout(timer)
      pendingRequests.delete(requestId)
      reject(err)
    }
  })
}

// 清理WebSocket连接
export function cleanupWebSocket(): void {
  if (globalWs) {
    try { globalWs.terminate() } catch {}
    globalWs = null
  }
  if (wss) {
    try { wss.close() } catch {}
    wss = null
  }
  clients.clear()
}

// 消息发送
async function sendMinecraftMessage(type: string, params: any = {}, successHint?: string): Promise<string> {
  if ((globalWs === null || globalWs.readyState !== WebSocket.OPEN) && clients.size === 0) {
    return '未连接到 Minecraft 服务器，请检查连接状态。'
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

    const response = await sendRequestAndWaitResponse(apiData.api, apiData.data)

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
  session?: Session
): Promise<void> {
  if (!command) return autoRecall('请输入要执行的命令', session)
  if (!config.link.rconPassword) return autoRecall('请先配置RCON密码', session)

  const [serverHost, portStr] = (config.link.defaultRcon || '').split(':')
  const port = portStr ? parseInt(portStr) : 25575

  if (!serverHost) return autoRecall('请先配置RCON地址', session)
  if (isNaN(port)) return autoRecall('RCON端口不正确', session)

  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.link.rconPassword
    })

    const result = await rcon.send(command)
    await rcon.end()

    return autoRecall(`命令执行成功${result}`, session)
  } catch (error) {
    return autoRecall(`RCON连接失败: ${error.message}`, session)
  }
}

// WebSocket消息处理
function handleIncomingMessage(ctx: Context, config: MinecraftToolsConfig, message: string): void {
  try {
    const data = JSON.parse(message)
    // 处理请求响应
    if (data.request_id && pendingRequests.has(data.request_id)) {
      const pendingRequest = pendingRequests.get(data.request_id)
      if (pendingRequest) {
        clearTimeout(pendingRequest.timer)
        pendingRequests.delete(data.request_id)
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
    const serverName = data.server_name || '服务器'

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
function initWebSocketServer(ctx: Context, config: MinecraftToolsConfig): void {
  const wsConfig = config.link
  const { host, port } = parseWsAddress(wsConfig.defaultWs)

  wss = new WebSocketServer({ host, port })
  ctx.logger.info(`WebSocket 服务器启动 ws://${host}:${port}`)

  wss.on('connection', (ws, req) => {
    const headers = {
      authorization: req.headers.authorization as string || '',
      'x-self-name': req.headers['x-self-name'] as string || '',
      'x-client-origin': req.headers['x-client-origin'] as string || ''
    }

    if (!verifyHeaders(headers, wsConfig.token)) {
      ws.close(1008, 'Invalid header!')
      return
    }

    ctx.logger.info(`新的客户端连接: ${headers['x-self-name']} (${req.socket.remoteAddress})`)
    clients.add(ws)

    ws.send(JSON.stringify({
      api: "subscribe_events",
      data: { events: getSubscribedEvents(wsConfig.events) }
    }))

    ws.on('message', (data) => handleIncomingMessage(ctx, config, data.toString()))
    ws.on('close', () => {
      ctx.logger.info(`客户端断开连接: ${headers['x-self-name']}`)
      clients.delete(ws)
    })
    ws.on('error', (error) => {
      ctx.logger.error(`WebSocket 服务器错误: ${error.message}`)
      clients.delete(ws)
    })
  })

  wss.on('error', (error) => ctx.logger.error(`WebSocket 服务器错误: ${error.message}`))
}

// WebSocket客户端初始化
function initWebSocketClient(ctx: Context, config: MinecraftToolsConfig): void {
  const wsConfig = config.link
  const { host, port } = parseWsAddress(wsConfig.defaultWs)

  globalWs = new WebSocket(`ws://${host}:${port}/minecraft/ws`, {
    headers: {
      "x-self-name": wsConfig.serverName,
      "Authorization": `Bearer ${wsConfig.token}`,
      "x-client-origin": "koishi"
    }
  })

  globalWs.on('open', () => {
    ctx.logger.info('WebSocket 客户端连接成功')
    reconnectCount = 0

    globalWs.send(JSON.stringify({
      api: "subscribe_events",
      data: { events: getSubscribedEvents(wsConfig.events) }
    }))
  })

  globalWs.on('message', (data) => handleIncomingMessage(ctx, config, data.toString()))
  globalWs.on('error', (error) => ctx.logger.error(`WebSocket 客户端错误: ${error.message}`))
  globalWs.on('close', (code, reason) => {
    ctx.logger.warn(`WebSocket 客户端连接关闭: ${code} ${reason.toString()}`)
    globalWs = null

    if (reconnectCount < 3) {
      reconnectCount++
      setTimeout(() => initWebSocketClient(ctx, config), 20000)
    } else {
      ctx.logger.error(`WebSocket 连接失败`)
    }
  })
}

// 初始化WebSocket通信
export function initWebSocketCommunication(ctx: Context, config: MinecraftToolsConfig): void {
  if (!isWsEnabled(config)) return

  cleanupWebSocket()
  config.link.mode === 'client' ? initWebSocketClient(ctx, config) : initWebSocketServer(ctx, config)
  // 处理消息转发到Minecraft
  ctx.on('message', (session) => {
    if (!isChannelInList(session, config.link.groups) ||
        session.content.startsWith('/') ||
        session.content.startsWith('.')) {
      return
    }

    const { output, color } = extractAndRemoveColor(session.content)
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

// 命令注册
export function registerServerCommands(parent: any, config: MinecraftToolsConfig, ctx: Context) {
  // 主命令
  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .action(async ({ session }) => {
      const isWsConnected = globalWs || clients.size > 0
      const statusMessage = [
        `连接类型: ${
          config.link.connectionType === 'both' ? 'RCON 和 WebSocket' :
          config.link.connectionType === 'rcon' ? 'RCON' :
          config.link.connectionType === 'ws' ? 'WebSocket' : '未连接'
        }`
      ]

      if (isWsEnabled(config)) {
        statusMessage.push(`WebSocket: ${isWsConnected ? '已连接' : '未连接'}`)
        statusMessage.push(`模式: ${config.link.mode === 'client' ? '客户端' : '服务端'}`)
        statusMessage.push(`地址: ${config.link.defaultWs}`)
      }

      if (isRconEnabled(config)) {
        statusMessage.push(`RCON: 已配置 (${config.link.defaultRcon})`)
      }

      if (config.link.groups.length > 0) {
        statusMessage.push(`消息转发群组: ${config.link.groups.join(', ')}`)
      }

      if (isWsEnabled(config) && !isWsConnected) {
        statusMessage.push('\n正在自动重新连接WebSocket...')
        cleanupWebSocket()
        initWebSocketCommunication(ctx, config)
      }

      return autoRecall(statusMessage.join('\n'), session)
    })
  // 检查群组权限
  const checkGroupPermission = ({ session }) => {
    if (!isChannelInList(session, config.link.groups)) {
      return autoRecall('此群组没有权限执行服务器命令', session)
    }
  }
  // 消息发送命令
  mcserver.subcommand('.say <message:text>', '发送消息')
    .before(checkGroupPermission)
    .action(async ({ session }, message) => {
      if (!message) return autoRecall('请输入要发送的消息', session)

      if (isWsEnabled(config)) {
        const result = await sendMinecraftMessage('text', { message })
        return autoRecall(result, session)
      } else if (isRconEnabled(config)) {
        const userIdentifier = session.username || session.userId
        return executeRconCommand(`say ${userIdentifier}: ${message}`, config, session)
      }
    })
  mcserver.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .before(checkGroupPermission)
    .action(async ({ session }, player, message) => {
      if (!player || !message) return autoRecall('用法: mc.server.tell <玩家名> <消息>', session)

      if (isWsEnabled(config)) {
        const result = await sendMinecraftMessage('private', { player, message }, `向玩家 ${player} 发送消息成功`)
        return autoRecall(result, session)
      } else if (isRconEnabled(config)) {
        const userIdentifier = session.username || session.userId
        return executeRconCommand(`tell ${player} ${userIdentifier}: ${message}`, config, session)
      }
    })
  // 标题和动作栏命令
  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-s <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .before(checkGroupPermission)
    .action(async ({ options, session }, title, subtitle = '') => {
      if (!title) return autoRecall('请输入要发送的标题', session)

      if (isWsEnabled(config)) {
        const result = await sendMinecraftMessage('title', {
          title,
          subtitle,
          fadein: options.fadein * 20,
          stay: options.stay * 20,
          fadeout: options.fadeout * 20
        })
        return autoRecall(result, session)
      } else if (isRconEnabled(config)) {
        // 使用RCON执行
        let cmd = `title @a title {"text":"${title}"}`
        await executeRconCommand(cmd, config, session)

        if (subtitle) {
          cmd = `title @a subtitle {"text":"${subtitle}"}`
          await executeRconCommand(cmd, config, session)
        }

        cmd = `title @a times ${options.fadein * 20} ${options.stay * 20} ${options.fadeout * 20}`
        return executeRconCommand(cmd, config, session)
      }
    })
  mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
    .before(checkGroupPermission)
    .action(async ({ session }, message) => {
      if (!message) return autoRecall('请输入要发送的消息', session)

      if (isWsEnabled(config)) {
        const result = await sendMinecraftMessage('actionbar', { message })
        return autoRecall(result, session)
      } else if (isRconEnabled(config)) {
        const cmd = `title @a actionbar {"text":"${message}"}`
        return executeRconCommand(cmd, config, session)
      }
    })
  // 玩家信息查询命令
  mcserver.subcommand('.player', '获取服务器在线玩家信息')
    .before(checkGroupPermission)
    .action(async ({ session }) => {
      if (isWsEnabled(config)) {
        try {
          await session.send('正在获取服务器玩家信息...')
          const response = await sendRequestAndWaitResponse('get_players')

          if (!response.data || !response.data.players) {
            return autoRecall('没有获取到玩家信息或服务器返回数据格式错误。', session)
          }

          const { players, server_name = '服务器', server_type = 'unknown', max_players = '?' } = response.data

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
          if (isRconEnabled(config)) {
            return executeRconCommand('list', config, session)
          }
          return autoRecall(`获取信息失败: ${error.message}`, session)
        }
      } else if (isRconEnabled(config)) {
        return executeRconCommand('list', config, session)
      }
    })
  // 广播消息命令
  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .before(checkGroupPermission)
    .action(async ({ session }, message) => {
      if (!message) return autoRecall('请输入要广播的消息', session)

      if (isWsEnabled(config)) {
        const result = await sendMinecraftMessage('text', { message })
        return autoRecall(result, session)
      } else if (isRconEnabled(config)) {
        return executeRconCommand(`say ${message}`, config, session)
      }
    })
  // 服务器状态
  mcserver.subcommand('.status', '查看服务器状态')
    .before(checkGroupPermission)
    .action(async ({ session }) => {
      if (isWsEnabled(config)) {
        try {
          const response = await sendRequestAndWaitResponse('get_server_status')

          if (!response.data) {
            if (isRconEnabled(config)) {
              return executeRconCommand('list', config, session)
            }
            return autoRecall('无法获取服务器状态信息', session)
          }

          const {
            server_name = '服务器',
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
          if (isRconEnabled(config)) {
            return executeRconCommand('list', config, session)
          }
          return autoRecall(`获取服务器状态失败: ${error.message}`, session)
        }
      } else if (isRconEnabled(config)) {
        try {
          const listPromise = new Promise<string>(async (resolve) => {
            const rcon = await Rcon.connect({
              host: config.link.defaultRcon.split(':')[0],
              port: parseInt(config.link.defaultRcon.split(':')[1]) || 25575,
              password: config.link.rconPassword
            })

            const listResult = await rcon.send('list')
            await rcon.end()
            resolve(listResult)
          })

          const result = await listPromise
          return autoRecall(`服务器状态:\n${result}`, session)
        } catch (error) {
          return autoRecall(`RCON连接失败: ${error.message}`, session)
        }
      }
    })
  // 只有RCON才支持的命令
  if (isRconEnabled(config)) {
    const executeAdminCommand = (command, requiredInput, usage, session, player, reason) => {
      if (!player && requiredInput) return autoRecall(usage, session)
      const cmd = `${command}${player ? ` ${player}` : ''}${reason ? ` ${reason}` : ''}`
      return executeRconCommand(cmd, config, session)
    }
    // 玩家管理命令
    mcserver.subcommand('.kick <player:string> [reason:text]', '踢出玩家', { authority: 2 })
      .before(checkGroupPermission)
      .action(({ session }, player, reason) =>
        executeAdminCommand('kick', true, '请输入玩家名', session, player, reason))
    mcserver.subcommand('.ban <player:string> [reason:text]', '封禁玩家', { authority: 3 })
      .option('ip', '--ip 封禁IP')
      .before(checkGroupPermission)
      .action(({ options, session }, player, reason) =>
        executeAdminCommand(options.ip ? 'ban-ip' : 'ban', true, '请输入玩家名或IP地址', session, player, reason))
    mcserver.subcommand('.op <player:string>', '管理管理员', { authority: 3 })
      .option('r', '-r 移除权限')
      .before(checkGroupPermission)
      .action(({ options, session }, player) =>
        executeAdminCommand(options.r ? 'deop' : 'op', true, '请输入玩家名', session, player, null))
    // 服务器管理命令
    mcserver.subcommand('.wl [player:string]', '管理白名单', { authority: 2 })
      .option('r', '-r 移除玩家')
      .option('on', '--on 开启白名单')
      .option('off', '--off 关闭白名单')
      .before(checkGroupPermission)
      .action(({ options, session }, player) => {
        let cmd;
        if (options.off) cmd = 'whitelist off'
        else if (options.on) cmd = 'whitelist on'
        else if (options.r) {
          if (!player) return autoRecall('请输入玩家名', session)
          cmd = `whitelist remove ${player}`
        }
        else if (player) cmd = `whitelist add ${player}`
        else cmd = 'whitelist list'

        return executeRconCommand(cmd, config, session)
      })
    // 执行自定义命令
    mcserver.subcommand('.run <command:text>', '执行自定义命令')
      .before(checkGroupPermission)
      .action(async ({ session }, command) => {
        if (!command) return autoRecall('请输入要执行的命令', session)

        if (!config.link.sudoUsers.includes(session?.userId)) {
          return autoRecall('你没有权限执行自定义命令', session)
        }
        return executeRconCommand(command, config, session)
      })
  }
}
