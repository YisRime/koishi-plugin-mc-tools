import { Session } from 'koishi'
import { Rcon } from 'rcon-client'
import { MinecraftToolsConfig } from './index'
import { WebSocket, WebSocketServer } from 'ws'
import { Context } from 'koishi'

// 全局WebSocket相关变量
export let minecraftSocket: WebSocket | null = null
let wsServer: WebSocketServer | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectCount = 0

/**
 * 发送临时消息（自动撤回）
 */
export async function sendTempMessage(message: string, session?: Session): Promise<void> {
  if (!session) return

  const msgId = await session.send(message)
  if (!msgId) return

  setTimeout(() => {
    try {
      const ids = Array.isArray(msgId) ? msgId : [msgId]
      ids.forEach(id => session.bot?.deleteMessage(session.channelId, String(id)))
    } catch {}
  }, 10000)
}

/**
 * 执行RCON命令
 */
export async function executeRconCommand(
  command: string,
  config: MinecraftToolsConfig,
  session?: Session
): Promise<void> {
  if (!command) return sendTempMessage('请输入要执行的命令', session)
  if (!config.link.rconPassword) return sendTempMessage('请先配置RCON密码', session)

  const [serverHost, portStr] = (config.link.rconAddress || '').split(':')
  const port = portStr ? parseInt(portStr) : 25575

  if (!serverHost) return sendTempMessage('请先配置RCON地址', session)
  if (isNaN(port)) return sendTempMessage('RCON端口不正确', session)

  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.link.rconPassword
    })

    const result = await rcon.send(command)
    await rcon.end()

    return sendTempMessage(`命令执行成功${result}`, session)
  } catch (error) {
    const errorMsg = `RCON连接失败: ${error.message}`
    return sendTempMessage(errorMsg, session)
  }
}

/**
 * 检查群组是否有权限
 */
export function hasGroupPermission(session, groupId: string): boolean {
  if (!groupId || !session) return false

  // 创建授权格式 "平台:群组ID"
  const currentGroup = `${session.platform}:${session.guildId}`
  return currentGroup === groupId
}

/**
 * 初始化WebSocket通信
 */
export function initWebSocket(ctx: Context, config: MinecraftToolsConfig) {
  if (!config.link.enableWebSocket) return

  if (config.link.websocketMode === 'client') {
    connectAsClient(ctx, config)
  } else {
    startWebSocketServer(ctx, config)
  }
}

/**
 * 作为客户端连接到WebSocket服务器
 */
function connectAsClient(ctx: Context, config: MinecraftToolsConfig) {
  const logger = ctx.logger('mc-tools:ws')
  const [host, portStr] = config.link.websocketAddress.split(':')
  const port = portStr ? parseInt(portStr) : 8080
  const url = `ws://${host}:${port}/minecraft/ws`

  const headers = {
    'Authorization': `Bearer ${config.link.websocketToken}`,
    'x-self-name': config.link.name,
    'x-client-origin': 'koishi'
  }

  try {
    minecraftSocket = new WebSocket(url, { headers })

    minecraftSocket.on('open', () => {
      logger.info(`成功连接到WebSocket服务器: ${url}`)
      reconnectCount = 0

      // 发送连接成功消息
      if (config.link.group) {
        const [platform, channelId] = config.link.group.split(':')
        ctx.bots.filter(bot => bot.platform === platform)
          .forEach(bot => bot.sendMessage(channelId, `✅ 已连接到Minecraft服务器 ${config.link.name}`))
      }
    })

    minecraftSocket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.event_name && config.link.group) {
          handleMinecraftEvent(ctx, message, config)
        }
      } catch (err) {
        logger.error('无法解析收到的WebSocket消息:', err)
      }
    })

    minecraftSocket.on('error', (err) => {
      logger.error('WebSocket连接错误:', err)
    })

    minecraftSocket.on('close', () => {
      logger.warn('WebSocket连接已关闭，尝试重新连接...')

      if (reconnectCount < 10) {
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => {
          reconnectCount++
          connectAsClient(ctx, config)
        }, 5000 * Math.min(reconnectCount + 1, 5))
      } else {
        logger.error('重连次数过多，停止尝试')
        if (config.link.group) {
          const [platform, channelId] = config.link.group.split(':')
          ctx.bots.filter(bot => bot.platform === platform)
            .forEach(bot => bot.sendMessage(channelId, `❌ 无法连接到Minecraft服务器，已停止尝试`))
        }
      }
    })
  } catch (err) {
    logger.error('创建WebSocket连接失败:', err)

    // 尝试重连
    if (reconnectCount < 10) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        reconnectCount++
        connectAsClient(ctx, config)
      }, 5000 * Math.min(reconnectCount + 1, 5))
    }
  }
}

/**
 * 启动WebSocket服务器
 */
function startWebSocketServer(ctx: Context, config: MinecraftToolsConfig) {
  const logger = ctx.logger('mc-tools:ws')
  const [host, portStr] = config.link.websocketAddress.split(':')
  const port = portStr ? parseInt(portStr) : 8080

  try {
    wsServer = new WebSocketServer({ host, port })
    logger.info(`WebSocket服务器已启动: ws://${host}:${port}`)

    wsServer.on('connection', (ws, req) => {
      const auth = req.headers.authorization
      const selfName = req.headers['x-self-name']

      // 验证Token和服务器名称
      if (!auth || auth !== `Bearer ${config.link.websocketToken}` ||
          !selfName || selfName !== config.link.name) {
        logger.warn('WebSocket连接验证失败')
        ws.close(1008, 'Authorization failed')
        return
      }

      logger.info('Minecraft服务器已连接')
      minecraftSocket = ws

      // 通知群组
      if (config.link.group) {
        const [platform, channelId] = config.link.group.split(':')
        ctx.bots.filter(bot => bot.platform === platform)
          .forEach(bot => bot.sendMessage(channelId, `✅ Minecraft服务器 ${config.link.name} 已连接`))
      }

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.event_name && config.link.group) {
            handleMinecraftEvent(ctx, message, config)
          }
        } catch (err) {
          logger.error('无法解析收到的WebSocket消息:', err)
        }
      })

      ws.on('close', () => {
        logger.warn('Minecraft服务器断开连接')
        minecraftSocket = null

        // 通知群组
        if (config.link.group) {
          const [platform, channelId] = config.link.group.split(':')
          ctx.bots.filter(bot => bot.platform === platform)
            .forEach(bot => bot.sendMessage(channelId, `❌ Minecraft服务器 ${config.link.name} 已断开连接`))
        }
      })

      ws.on('error', (err) => {
        logger.error('WebSocket连接错误:', err)
      })
    })

    wsServer.on('error', (err) => {
      logger.error('WebSocket服务器错误:', err)
    })
  } catch (err) {
    logger.error('启动WebSocket服务器失败:', err)
  }
}

/**
 * 处理来自Minecraft的事件
 */
function handleMinecraftEvent(ctx: Context, message: any, config: MinecraftToolsConfig) {
  const logger = ctx.logger('mc-tools:ws')
  const [platform, channelId] = config.link.group.split(':')

  try {
    const serverName = message.server_name || config.link.name
    let content = ''

    // 根据事件类型构建消息
    switch (message.event_name) {
      case 'AsyncPlayerChatEvent':
      case 'ServerMessageEvent':
      case 'ServerChatEvent':
      case 'NeoServerChatEvent':
      case 'MinecraftPlayerChatEvent':
      case 'BaseChatEvent':
      case 'VelocityPlayerChatEvent':
        content = `[${serverName}] ${message.player?.nickname || '服务器'}: ${message.message || ''}`
        break

      case 'PlayerJoinEvent':
      case 'ServerPlayConnectionJoinEvent':
      case 'PlayerLoggedInEvent':
      case 'NeoPlayerLoggedInEvent':
      case 'MinecraftPlayerJoinEvent':
      case 'BaseJoinEvent':
      case 'VelocityLoginEvent':
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 加入了游戏`
        break

      case 'PlayerQuitEvent':
      case 'ServerPlayConnectionDisconnectEvent':
      case 'PlayerLoggedOutEvent':
      case 'NeoPlayerLoggedOutEvent':
      case 'MinecraftPlayerQuitEvent':
      case 'BaseQuitEvent':
      case 'VelocityDisconnectEvent':
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 离开了游戏`
        break

      case 'PlayerDeathEvent':
      case 'NeoPlayerDeathEvent':
      case 'ServerLivingEntityAfterDeathEvent':
      case 'BaseDeathEvent':
        content = `[${serverName}] ${message.message || `${message.player?.nickname || '玩家'} 死亡了`}`
        break

      default:
        if (message.message) {
          content = `[${serverName}] ${message.message}`
        }
    }

    if (content) {
      ctx.bots.filter(bot => bot.platform === platform)
        .forEach(bot => bot.sendMessage(channelId, content))
    }
  } catch (err) {
    logger.error('处理Minecraft事件失败:', err)
  }
}

/**
 * 清理WebSocket连接
 */
export function cleanupWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (minecraftSocket) {
    minecraftSocket.close()
    minecraftSocket = null
  }

  if (wsServer) {
    wsServer.close()
    wsServer = null
  }
}

/**
 * 创建Minecraft格式文本组件
 */
export function createMcText(text: string, styles: {
  color?: string,
  bold?: boolean,
  italic?: boolean,
  underlined?: boolean,
  strikethrough?: boolean,
  obfuscated?: boolean
} = {}): any {
  return {
    type: 'text',
    data: {
      text,
      color: styles.color || 'white',
      bold: styles.bold || false,
      italic: styles.italic || false,
      underlined: styles.underlined || false,
      strikethrough: styles.strikethrough || false,
      obfuscated: styles.obfuscated || false
    }
  };
}

/**
 * 确保消息是数组格式
 */
function ensureArray(message: any): any[] {
  return Array.isArray(message) ? message : [message];
}

/**
 * 发送API请求到Minecraft服务器
 */
export async function sendApiRequest(
  api: string,
  data: any,
  session?: Session
): Promise<boolean> {
  if (!minecraftSocket) {
    await sendTempMessage('WebSocket未连接', session)
    return false
  }

  try {
    const request = {
      api,
      data,
      echo: Date.now().toString()
    }

    minecraftSocket.send(JSON.stringify(request))
    return true
  } catch (error) {
    await sendTempMessage(`发送WebSocket消息失败: ${error.message}`, session)
    return false
  }
}

/**
 * 发送消息到Minecraft并处理结果反馈
 */
export async function sendToMinecraft(
  options: {
    api: string,
    data: any,
    session?: Session,
    successMsg?: string,
    failMsg?: string
  }
): Promise<boolean> {
  const { api, data, session, successMsg = '消息已发送', failMsg = '消息发送失败' } = options;

  const success = await sendApiRequest(api, data, session);
  if (session) {
    await sendTempMessage(success ? successMsg : failMsg, session);
  }
  return success;
}

/**
 * 发送普通消息到Minecraft服务器
 * API: send_msg
 */
export async function sendChatMessage(
  message: any,
  session?: Session,
  feedback: boolean = true
): Promise<boolean> {
  const messageData = {
    message: ensureArray(message)
  }

  if (!feedback) return sendApiRequest('send_msg', messageData, session);

  return sendToMinecraft({
    api: 'send_msg',
    data: messageData,
    session,
    successMsg: '消息已发送',
    failMsg: '消息发送失败'
  });
}

/**
 * 发送广播消息到Minecraft服务器
 * API: broadcast
 */
export async function broadcastToServer(
  message: any,
  session?: Session,
  feedback: boolean = true
): Promise<boolean> {
  const messageData = {
    message: ensureArray(message)
  }

  if (!feedback) return sendApiRequest('broadcast', messageData, session);

  return sendToMinecraft({
    api: 'broadcast',
    data: messageData,
    session,
    successMsg: '广播已发送',
    failMsg: '广播发送失败'
  });
}

/**
 * 发送私聊消息到Minecraft玩家
 */
export async function whisperToPlayer(
  player: string,
  message: any,
  session?: Session,
  feedback: boolean = true
): Promise<boolean> {
  // 判断player是否为UUID格式
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player)

  const messageData = {
    uuid: isUUID ? player : '',
    nickname: isUUID ? '' : player,
    message: ensureArray(message)
  }

  if (!feedback) return sendApiRequest('send_private_msg', messageData, session);

  return sendToMinecraft({
    api: 'send_private_msg',
    data: messageData,
    session,
    successMsg: '私聊消息已发送',
    failMsg: '私聊消息发送失败'
  });
}

/**
 * 发送标题到Minecraft服务器
 */
export async function sendTitle(
  title: any,
  subtitle: any = '',
  fadein: number = 10,
  stay: number = 70,
  fadeout: number = 20,
  session?: Session,
  feedback: boolean = true
): Promise<boolean> {
  const titleData = {
    title: ensureArray(title),
    subtitle: subtitle ? ensureArray(subtitle) : '',
    fadein,
    stay,
    fadeout
  }

  if (!feedback) return sendApiRequest('send_title', titleData, session);

  return sendToMinecraft({
    api: 'send_title',
    data: titleData,
    session,
    successMsg: '标题已发送',
    failMsg: '标题发送失败'
  });
}

/**
 * 发送动作栏消息到Minecraft服务器
 */
export async function sendActionbar(
  message: any,
  session?: Session,
  feedback: boolean = true
): Promise<boolean> {
  const actionbarData = {
    message: ensureArray(message)
  }

  if (!feedback) return sendApiRequest('send_actionbar', actionbarData, session);

  return sendToMinecraft({
    api: 'send_actionbar',
    data: actionbarData,
    session,
    successMsg: '动作栏消息已发送',
    failMsg: '动作栏消息发送失败'
  });
}
