import { Context, Session } from 'koishi'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { MinecraftToolsConfig } from './index'

// 全局状态
let globalWs: WebSocket | null = null
let wss: WebSocketServer | null = null
const clients = new Set<WebSocket>()
let reconnectCount = 0

// Minecraft 事件枚举
export enum McEvent {
  // 消息类事件 (post_type: message)
  '聊天消息' = 1 << 0,
  '玩家命令' = 1 << 1,
  '玩家死亡' = 1 << 2,
  // 通知类事件 (post_type: notice)
  '玩家加入' = 1 << 3,
  '玩家退出' = 1 << 4,
  // 原始枚举名称
  AsyncPlayerChatEvent = 1 << 0,
  PlayerCommandPreprocessEvent = 1 << 1,
  PlayerDeathEvent = 1 << 2,
  PlayerJoinEvent = 1 << 3,
  PlayerQuitEvent = 1 << 4,
  // 按照子类型分类
  chat = 1 << 0,
  player_command = 1 << 1,
  death = 1 << 2,
  join = 1 << 3,
  quit = 1 << 4,
  // 添加原版端事件名称对应的枚举
  MinecraftPlayerChatEvent = 1 << 0,
  MinecraftPlayerJoinEvent = 1 << 3,
  MinecraftPlayerQuitEvent = 1 << 4,
  // 添加 Fabric 服务端事件名称对应的枚举
  ServerMessageEvent = 1 << 0,
  ServerCommandMessageEvent = 1 << 1,
  ServerLivingEntityAfterDeathEvent = 1 << 2,
  ServerPlayConnectionJoinEvent = 1 << 3,
  ServerPlayConnectionDisconnectEvent = 1 << 4,
  // 添加 Forge 服务端事件名称对应的枚举
  ServerChatEvent = 1 << 0,
  CommandEvent = 1 << 1,
  PlayerLoggedInEvent = 1 << 3,
  PlayerLoggedOutEvent = 1 << 4,
  // 添加 NeoForge 服务端事件名称对应的枚举
  NeoServerChatEvent = 1 << 0,
  NeoCommandEvent = 1 << 1,
  NeoPlayerDeathEvent = 1 << 2,
  NeoPlayerLoggedInEvent = 1 << 3,
  NeoPlayerLoggedOutEvent = 1 << 4
}

// 事件子类型到枚举值的映射
const subTypeToEventMap = {
  'chat': McEvent.chat,
  'player_command': McEvent.player_command,
  'death': McEvent.death,
  'join': McEvent.join,
  'quit': McEvent.quit
}

// 服务端类型
type ServerType = 'origin' | 'spigot' | 'forge' | 'neoforge' | 'fabric' | 'velocity' | 'unknown'

// 事件名称到子类型的映射表
const eventMap = {
  // 原版事件
  MinecraftPlayerChatEvent: 'chat',
  MinecraftPlayerJoinEvent: 'join',
  MinecraftPlayerQuitEvent: 'quit',
  // Spigot事件
  AsyncPlayerChatEvent: 'chat',
  ServerMessageEvent: 'chat',
  ServerChatEvent: 'chat',
  PlayerCommandPreprocessEvent: 'player_command',
  PlayerDeathEvent: 'death',
  PlayerJoinEvent: 'join',
  PlayerQuitEvent: 'quit',
  // Fabric事件
  ServerCommandMessageEvent: 'player_command',
  ServerLivingEntityAfterDeathEvent: 'death',
  ServerPlayConnectionJoinEvent: 'join',
  ServerPlayConnectionDisconnectEvent: 'quit',
  // Forge事件
  CommandEvent: 'player_command',
  PlayerLoggedInEvent: 'join',
  PlayerLoggedOutEvent: 'quit',
  // NeoForge事件
  NeoServerChatEvent: 'chat',
  NeoCommandEvent: 'player_command',
  NeoPlayerDeathEvent: 'death',
  NeoPlayerLoggedInEvent: 'join',
  NeoPlayerLoggedOutEvent: 'quit'
}

// WebSocket 请求管理
let requestIdCounter = 0
const pendingRequests = new Map<number, {
  resolve: (value: any) => void,
  reject: (reason: any) => void,
  timer: NodeJS.Timeout
}>()

/**
 * 将事件位掩码转换为订阅的事件列表
 */
function getSubscribedEvents(eventMask: number): string[] {
  const events: string[] = []
  for (const [key, value] of Object.entries(McEvent)) {
    if (typeof value === 'number' && (eventMask & value)) {
      if (!isNaN(Number(key)) && !['chat', 'player_command', 'death', 'join', 'quit'].includes(key)) {
        events.push(key)
      }
    }
  }
  return events
}

/**
 * 处理事件和玩家信息的辅助函数
 */
function getEventSubType(eventName: string): string {
  return eventMap[eventName] || 'unknown'
}

function getPlayerName(player: any): string {
  if (!player) return '玩家'
  if (typeof player === 'string') return player
  return player.nickname || player.display_name || player.name || '玩家'
}

function getPlayerDetails(player: any, serverType: ServerType = 'unknown'): Record<string, any> {
  const details: Record<string, any> = {}

  if (!player || typeof player === 'string') return details

  // 通用属性
  if (player.nickname) details.nickname = player.nickname
  if (player.uuid) details.uuid = player.uuid
  if (player.level !== undefined) details.level = player.level

  // Spigot 特有属性
  if (serverType === 'spigot') {
    if (player.is_op !== undefined) details.is_op = player.is_op
    if (player.exp !== undefined) details.exp = player.exp
    if (player.ping !== undefined && player.ping >= 0) details.ping = player.ping
    if (player.is_flying !== undefined) details.is_flying = player.is_flying
    if (player.is_sneaking !== undefined) details.is_sneaking = player.is_sneaking
  }

  // Fabric 特有属性
  if (serverType === 'fabric') {
    if (player.ip) details.ip = player.ip
    if (player.block_x !== undefined && player.block_y !== undefined && player.block_z !== undefined) {
      details.location = `${player.block_x}, ${player.block_y}, ${player.block_z}`
    }
    if (player.is_creative !== undefined) details.gamemode = player.is_creative ? '创造模式' : '生存模式'
    if (player.is_spectator !== undefined && player.is_spectator) details.gamemode = '旁观模式'
    if (player.movement_speed !== undefined) details.speed = player.movement_speed
  }

  // Forge/NeoForge 特有属性
  if (serverType === 'forge' || serverType === 'neoforge') {
    if (player.ipAddress) details.ip = player.ipAddress
    if (player.block_x !== undefined && player.block_y !== undefined && player.block_z !== undefined) {
      details.location = `${player.block_x}, ${player.block_y}, ${player.block_z}`
    }
    if (player.game_mode) {
      const gameModeMap: Record<string, string> = {
        'survival': '生存模式',
        'creative': '创造模式',
        'adventure': '冒险模式',
        'spectator': '旁观模式'
      }
      details.gamemode = gameModeMap[player.game_mode] || player.game_mode
    }
    if (player.speed !== undefined) details.speed = player.speed

    // 状态信息
    const statusInfo = []
    if (player.is_flying) statusInfo.push('飞行')
    if (player.is_swimming) statusInfo.push('游泳')
    if (player.is_sleeping) statusInfo.push('睡觉')
    if (player.is_blocking) statusInfo.push('格挡')

    if (statusInfo.length > 0) {
      details.status = statusInfo.join('/')
    }
  }

  return details
}

/**
 * 处理颜色代码和文本格式化
 */
export function extractAndRemoveColor(input: string): { output: string, color: string } {
  const regex = /&(\w+)&/
  const match = input.match(regex)
  return match ? { output: input.replace(regex, ''), color: match[1] } : { output: input, color: '' }
}

function formatTextWithStyles(text: string): any {
  const { output, color } = extractAndRemoveColor(text)

  const messageData: any = {
    text: output,
    color: color || "white"
  }

  // 提取并应用样式标记
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

  return {
    type: "text",
    data: messageData
  }
}

/**
 * WebSocket 通信核心功能
 */
function isChannelInList(session: Session, groups: string[]): boolean {
  if (!groups?.length || !session?.channelId) return false
  const channelKey = `${session.platform}:${session.channelId}`
  return groups.some(channel => channel === channelKey)
}

export function initWebSocketCommunication(ctx: Context, config: MinecraftToolsConfig): void {
  const wsConfig = config.link
  cleanupWebSocket()

  ctx.logger.info(`初始化 WebSocket ${wsConfig.mode === 'client' ? '客户端' : '服务端'} 模式`)

  // 根据模式初始化WebSocket
  wsConfig.mode === 'client' ? initWebSocketClient(ctx, config) : initWebSocketServer(ctx, config)

  // 注册消息接收处理
  ctx.on('message', (session) => {
    if (!isChannelInList(session, wsConfig.groups) ||
        session.content.startsWith('/') ||
        session.content.startsWith('.')) {
      return
    }

    const { output, color } = extractAndRemoveColor(session.content)

    // 构建发送到 Minecraft 的消息
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

function parseWsAddress(address: string): { host: string, port: number } {
  const parts = address.split(':')
  return { host: parts[0] || 'localhost', port: parseInt(parts[1], 10) || 8080 }
}

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

    // 发送事件订阅
    globalWs.send(JSON.stringify({
      api: "subscribe_events",
      data: { events: getSubscribedEvents(wsConfig.events) }
    }))
  })

  globalWs.on('message', (data) => {
    handleIncomingMessage(ctx, config, data.toString())
  })

  globalWs.on('error', (error) => {
    ctx.logger.error(`WebSocket 客户端错误: ${error.message}`)
  })

  globalWs.on('close', (code, reason) => {
    ctx.logger.warn(`WebSocket 客户端连接关闭: ${code} ${reason.toString()}`)
    globalWs = null

    // 自动重连逻辑
    if (reconnectCount < 3) {
      reconnectCount++
      ctx.logger.info(`尝试重连 (${reconnectCount}/3)，等待 20 秒...`)
      setTimeout(() => initWebSocketClient(ctx, config), 20 * 1000)
    } else {
      ctx.logger.error(`达到最大重连次数 (3)，不再尝试重连`)
    }
  })
}

function initWebSocketServer(ctx: Context, config: MinecraftToolsConfig): void {
  const wsConfig = config.link
  const { host, port } = parseWsAddress(wsConfig.defaultWs)

  wss = new WebSocketServer({ host, port })
  ctx.logger.info(`WebSocket 服务器启动 ws://${host}:${port}`)

  wss.on('connection', (ws, req) => {
    // 获取并验证请求头
    const headers = {
      authorization: req.headers.authorization as string || '',
      'x-self-name': req.headers['x-self-name'] as string || '',
      'x-client-origin': req.headers['x-client-origin'] as string || ''
    }

    if (!verifyHeaders(headers, wsConfig.token)) {
      ctx.logger.error('请求头验证失败!')
      ws.close(1008, 'Invalid header!')
      return
    }

    ctx.logger.info(`新的客户端连接: ${headers['x-self-name']} (${req.socket.remoteAddress})`)
    clients.add(ws)

    // 发送事件订阅
    ws.send(JSON.stringify({
      api: "subscribe_events",
      data: { events: getSubscribedEvents(wsConfig.events) }
    }))

    ws.on('message', (data) => {
      handleIncomingMessage(ctx, config, data.toString())
    })

    ws.on('close', () => {
      ctx.logger.info(`客户端断开连接: ${headers['x-self-name']}`)
      clients.delete(ws)
    })

    ws.on('error', (error) => {
      ctx.logger.error(`WebSocket 服务器错误: ${error.message}`)
      clients.delete(ws)
    })
  })

  wss.on('error', (error) => {
    ctx.logger.error(`WebSocket 服务器错误: ${error.message}`)
  })
}

function verifyHeaders(headers: any, token: string): boolean {
  if (!headers.authorization || !headers.authorization.startsWith('Bearer ')) return false
  const authToken = headers.authorization.substring(7)
  return authToken === token && headers['x-self-name'] && headers['x-client-origin']
}

/**
 * 消息处理和通信功能
 */
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

    // 处理事件消息
    if (!data.post_type && !data.event_name) {
      ctx.logger.debug('收到非事件消息:', message)
      return
    }

    // 处理事件类型
    const serverType = (data.server_type || 'unknown').toLowerCase() as ServerType
    const postType = data.post_type || 'unknown'
    const subType = data.sub_type || getEventSubType(data.event_name || '')
    const eventName = data.event_name || 'unknown'

    ctx.logger.debug(`收到事件 [${serverType}]: ${eventName} (${postType}/${subType})`)

    // 检查订阅
    const eventFlag = subTypeToEventMap[subType]
    if (!eventFlag || !(config.link.events & eventFlag)) return

    // 获取玩家名称
    const playerName = getPlayerName(data.player)

    // 格式化消息
    let formattedMsg = ''
    switch (subType) {
      case 'chat':
        formattedMsg = `[${data.server_name || '服务器'}] <${playerName}> ${data.message || ''}`
        break
      case 'player_command':
        formattedMsg = `[${data.server_name || '服务器'}] ${playerName} 执行命令: ${data.message || ''}`
        break
      case 'death':
        formattedMsg = `[${data.server_name || '服务器'}] ${data.message || `${playerName} 死亡了`}`
        break
      case 'join':
        formattedMsg = `[${data.server_name || '服务器'}] ${playerName} 加入了游戏`
        break
      case 'quit':
        formattedMsg = `[${data.server_name || '服务器'}] ${playerName} 退出了游戏`
        break
      default:
        ctx.logger.debug(`未处理的事件类型: ${subType}`)
        return
    }

    // 向配置的群组发送消息
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

export function sendWebSocketMessage(message: string): void {
  // 客户端模式
  if (globalWs && globalWs.readyState === WebSocket.OPEN) {
    globalWs.send(message)
    return
  }

  // 服务端模式 - 向所有连接的客户端广播
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
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId)
        reject(new Error('请求超时'))
      }
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

/**
 * 命令注册与资源清理
 */
export function registerWsCommands(parent: any, config: MinecraftToolsConfig, ctx: Context) {
  if (!config.link.enabledWs) return

  const mcws = parent.subcommand('.ws', 'Minecraft WebSocket 通信')
    .usage('mc.ws - Minecraft WebSocket 通信功能')

  // 状态命令(整合link和status)
  mcws.subcommand('.status', '查看 WebSocket 连接和配置状态')
    .action(async () => {
      if (!config.link.enabledWs) return 'WebSocket 功能未启用。'

      const status = ['=== Minecraft WebSocket 状态 ===']

      // 基本设置信息
      status.push(`模式: ${config.link.mode === 'client' ? '客户端' : '服务端'}`)
      status.push(`地址: ${config.link.defaultWs}`)

      // 当前连接状态
      if (config.link.mode === 'client') {
        status.push(`连接状态: ${globalWs ? '已连接' : '未连接'}`)
        status.push(`重连设置: 最多 3 次，间隔 20 秒`)
      } else {
        status.push(`已连接客户端: ${clients.size}`)
      }

      // 通信配置
      status.push('\n=== 通信配置 ===')
      status.push(`订阅事件掩码: ${config.link.events}`)

      if (config.link.groups.length > 0) {
        status.push(`消息转发群组: ${config.link.groups.join(', ')}`)
      } else {
        status.push('未配置消息转发群组')
      }

      if (config.link.enabledRcon) {
        status.push(`RCON: 已启用 (${config.link.defaultRcon})`)
      } else {
        status.push('RCON: 未启用')
      }

      return status.join('\n')
    })

  // 重连子命令
  mcws.subcommand('.reconnect', '重新连接 WebSocket')
    .action(async () => {
      cleanupWebSocket()
      initWebSocketCommunication(ctx, config)
      return 'WebSocket 重新连接已触发。'
    })

  // 发送消息子命令
  mcws.subcommand('.send <message:text>', '发送消息到服务器')
    .action(async (message) => {
      if (!message) return '请输入要发送的消息。'

      sendWebSocketMessage(JSON.stringify({
        api: "send_msg",
        data: {
          message: {
            type: "text",
            data: {
              text: message,
              color: "white"
            }
          }
        }
      }))

      return '消息已发送到服务器。'
    })

  // 获取在线玩家信息命令
  mcws.subcommand('.players', '获取服务器在线玩家信息')
    .action(async ({ session }) => {
      // 检查连接状态
      if ((config.link.mode === 'client' && !globalWs) ||
          (config.link.mode === 'server' && clients.size === 0)) {
        return '未连接到 Minecraft 服务器，请检查连接状态。'
      }

      try {
        await session.send('正在获取服务器玩家信息...')
        const response = await sendRequestAndWaitResponse('get_players')

        if (!response.data || !response.data.players) {
          return '没有获取到玩家信息或服务器返回数据格式错误。'
        }

        const players = response.data.players
        const serverType = response.data.server_type || 'unknown'

        if (players.length === 0) {
          return `[${response.data.server_name || '服务器'}] 当前没有在线玩家。`
        }

        // 格式化玩家信息
        let message = `[${response.data.server_name || '服务器'}] 在线玩家(${players.length}/${response.data.max_players || '?'}):\n`

        message += players.map((player: any) => {
          const name = getPlayerName(player)
          const details = getPlayerDetails(player, serverType as ServerType)

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

        return message
      } catch (error) {
        return `获取玩家信息失败: ${error.message}`
      }
    })

  // 执行命令
  mcws.subcommand('.execute <command:text>', '向服务器发送命令', { authority: 3 })
    .action(async (command) => {
      if (!command) return '请输入要执行的命令。'

      if ((config.link.mode === 'client' && !globalWs) ||
          (config.link.mode === 'server' && clients.size === 0)) {
        return '未连接到 Minecraft 服务器，请检查连接状态。'
      }

      try {
        const cmd = command.startsWith('/') ? command.substring(1) : command
        const response = await sendRequestAndWaitResponse('execute_command', { command: cmd })
        return `命令执行结果: ${response.message || '命令已发送'}`
      } catch (error) {
        return `执行命令失败: ${error.message}`
      }
    })

  // 广播消息
  mcws.subcommand('.broadcast <message:text>', '向服务器广播消息', { authority: 2 })
    .alias('.msg')
    .action(async (message) => {
      if (!message) return '请输入要广播的消息。'

      if ((config.link.mode === 'client' && !globalWs) ||
          (config.link.mode === 'server' && clients.size === 0)) {
        return '未连接到 Minecraft 服务器，请检查连接状态。'
      }

      try {
        await sendRequestAndWaitResponse('send_msg', {
          message: [formatTextWithStyles(message)]
        })
        return '消息已广播到服务器。'
      } catch (error) {
        return `广播消息失败: ${error.message}`
      }
    })

  // 私聊消息
  mcws.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .alias('.private')
    .action(async (player, message) => {
      if (!player || !message) return '请输入玩家名称和要发送的消息。'

      if ((config.link.mode === 'client' && !globalWs) ||
          (config.link.mode === 'server' && clients.size === 0)) {
        return '未连接到 Minecraft 服务器，请检查连接状态。'
      }

      try {
        const response = await sendRequestAndWaitResponse('send_private_msg', {
          nickname: player,
          message: [formatTextWithStyles(message)]
        })

        return response.message ?
          `私聊消息结果: ${response.message}` :
          `已向玩家 ${player} 发送私聊消息。`
      } catch (error) {
        return `发送私聊消息失败: ${error.message}`
      }
    })

  // 标题消息
  mcws.subcommand('.title <title:string> [subtitle:string]', '向服务器发送标题消息', { authority: 2 })
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-s <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .action(async ({ options }, title, subtitle = '') => {
      if (!title) return '请输入要显示的标题。'

      if ((config.link.mode === 'client' && !globalWs) ||
          (config.link.mode === 'server' && clients.size === 0)) {
        return '未连接到 Minecraft 服务器，请检查连接状态。'
      }

      try {
        const titleData: any = {
          title: [formatTextWithStyles(title)],
          fadein: options.fadein * 20,
          stay: options.stay * 20,
          fadeout: options.fadeout * 20
        }

        if (subtitle) {
          titleData.subtitle = [formatTextWithStyles(subtitle)]
        }

        await sendRequestAndWaitResponse('send_title', titleData)
        return '标题消息已发送到服务器。'
      } catch (error) {
        return `发送标题消息失败: ${error.message}`
      }
    })

  // 动作栏消息
  mcws.subcommand('.actionbar <message:text>', '向服务器发送动作栏消息', { authority: 2 })
    .action(async (message) => {
      if (!message) return '请输入要显示的动作栏消息。'

      if ((config.link.mode === 'client' && !globalWs) ||
          (config.link.mode === 'server' && clients.size === 0)) {
        return '未连接到 Minecraft 服务器，请检查连接状态。'
      }

      try {
        await sendRequestAndWaitResponse('send_actionbar', {
          message: [formatTextWithStyles(message)]
        })
        return '动作栏消息已发送到服务器。'
      } catch (error) {
        return `发送动作栏消息失败: ${error.message}`
      }
    })
}

export function cleanupWebSocket(): void {
  if (globalWs) {
    try { globalWs.terminate() } catch (e) { /* 忽略错误 */ }
    globalWs = null
  }

  if (wss) {
    try { wss.close() } catch (e) { /* 忽略错误 */ }
    wss = null
  }

  clients.clear()
}
