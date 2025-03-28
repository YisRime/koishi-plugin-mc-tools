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
    const serverType = message.server_type || '未知'
    let content = ''

    // 获取玩家位置信息（如果有）
    let locationInfo = ''
    if (message.player) {
      const player = message.player
      if (player.block_x !== undefined && player.block_y !== undefined && player.block_z !== undefined) {
        locationInfo = ` [位置: ${player.block_x}, ${player.block_y}, ${player.block_z}]`
      }
    }

    // 获取玩家游戏模式（如果有）
    let gameModeInfo = ''
    if (message.player) {
      if (message.player.game_mode) {
        // Forge/NeoForge格式
        gameModeInfo = ` [模式: ${message.player.game_mode}]`
      } else if (message.player.is_creative !== undefined) {
        // Fabric格式
        let mode = message.player.is_spectator ? '旁观者' :
                   message.player.is_creative ? '创造' : '生存'
        gameModeInfo = ` [模式: ${mode}]`
      }
    }

    // 根据事件类型构建消息
    switch (message.event_name) {
      // ============= 聊天事件 =============
      case 'AsyncPlayerChatEvent':         // Spigot
      case 'ServerMessageEvent':           // Fabric
      case 'ServerChatEvent':              // Forge
      case 'NeoServerChatEvent':           // NeoForge
      case 'MinecraftPlayerChatEvent':     // 原版
      case 'BaseChatEvent':                // 其他
      case 'VelocityPlayerChatEvent':      // Velocity
        content = `[${serverName}] ${message.player?.nickname || '服务器'}: ${message.message || ''}`
        break

      // ============= 命令事件 =============
      case 'PlayerCommandPreprocessEvent':  // Spigot
      case 'ServerCommandMessageEvent':     // Fabric
      case 'CommandEvent':                  // Forge
      case 'NeoCommandEvent':               // NeoForge
        const cmd = message.message?.trim() || ''
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 执行命令: ${cmd}${locationInfo}`
        break

      // ============= 加入事件 =============
      case 'PlayerJoinEvent':                     // Spigot
      case 'ServerPlayConnectionJoinEvent':       // Fabric
      case 'PlayerLoggedInEvent':                 // Forge
      case 'NeoPlayerLoggedInEvent':              // NeoForge
      case 'MinecraftPlayerJoinEvent':            // 原版
      case 'BaseJoinEvent':                       // 其他
      case 'VelocityLoginEvent':                  // Velocity
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 加入了游戏`

        // 添加玩家详细信息
        if (message.player) {
          // 添加显示名称（如果与昵称不同）
          if (message.player.display_name &&
              message.player.display_name !== message.player.nickname) {
            content += ` (显示名: ${message.player.display_name})`
          }

          // 添加游戏模式信息
          content += gameModeInfo

          // 添加位置信息
          content += locationInfo

          // 添加IP信息
          if (message.player.ip || message.player.ipAddress || message.player.address) {
            const ip = message.player.ip || message.player.ipAddress || message.player.address
            content += ` [IP: ${ip}]`
          }
        }
        break

      // ============= 离开事件 =============
      case 'PlayerQuitEvent':                     // Spigot
      case 'ServerPlayConnectionDisconnectEvent': // Fabric
      case 'PlayerLoggedOutEvent':                // Forge
      case 'NeoPlayerLoggedOutEvent':             // NeoForge
      case 'MinecraftPlayerQuitEvent':            // 原版
      case 'BaseQuitEvent':                       // 其他
      case 'VelocityDisconnectEvent':             // Velocity
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 离开了游戏${locationInfo}`
        break

      // ============= 死亡事件 =============
      case 'PlayerDeathEvent':                     // Spigot/Forge
      case 'NeoPlayerDeathEvent':                  // NeoForge
      case 'ServerLivingEntityAfterDeathEvent':    // Fabric
      case 'BaseDeathEvent':                       // 其他
        if (message.message) {
          content = `[${serverName}] ${message.message}`
        } else {
          content = `[${serverName}] ${message.player?.nickname || '玩家'} 死亡了${locationInfo}`
        }
        break

      // 其他事件类型
      default:
        if (message.message) {
          content = `[${serverName}] ${message.message}`
        } else if (message.event_name) {
          // 记录未知事件以便调试
          logger.debug(`收到未处理的事件类型: ${message.event_name}, 服务端类型: ${serverType}`)
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
 * 通用发送消息到Minecraft服务器函数
 * 整合了所有消息发送功能
 */
export async function sendMinecraftMessage(
  messageType: 'chat' | 'broadcast' | 'whisper' | 'title' | 'actionbar',
  message: any,
  options: {
    player?: string,                  // 玩家名称或UUID (whisper用)
    subtitle?: any,                   // 副标题 (title用)
    fadein?: number,                  // 淡入时间 (title用)
    stay?: number,                    // 停留时间 (title用)
    fadeout?: number,                 // 淡出时间 (title用)
    session?: Session,                // 会话对象
    feedback?: boolean                // 是否需要反馈
  } = {}
): Promise<boolean> {
  const {
    player = '',
    subtitle = '',
    fadein = 10,
    stay = 70,
    fadeout = 20,
    session,
    feedback = true
  } = options;

  let api: string;
  let messageData: any;
  let successMsg: string;
  let failMsg: string;

  // 消息始终确保是数组格式
  const msgArray = ensureArray(message);

  // 根据消息类型构建不同的API请求
  switch (messageType) {
    case 'chat':
      api = 'send_msg';
      messageData = { message: msgArray };
      successMsg = '消息已发送';
      failMsg = '消息发送失败';
      break;

    case 'broadcast':
      api = 'broadcast';
      messageData = { message: msgArray };
      successMsg = '广播已发送';
      failMsg = '广播发送失败';
      break;

    case 'whisper':
      if (!player) {
        await sendTempMessage('未指定玩家', session);
        return false;
      }
      api = 'send_private_msg';
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player);
      messageData = {
        uuid: isUUID ? player : '',
        nickname: isUUID ? '' : player,
        message: msgArray
      };
      successMsg = '私聊消息已发送';
      failMsg = '私聊消息发送失败';
      break;

    case 'title':
      api = 'send_title';
      messageData = {
        title: msgArray,
        subtitle: subtitle ? ensureArray(subtitle) : '',
        fadein,
        stay,
        fadeout
      };
      successMsg = '标题已发送';
      failMsg = '标题发送失败';
      break;

    case 'actionbar':
      api = 'send_actionbar';
      messageData = { message: msgArray };
      successMsg = '动作栏消息已发送';
      failMsg = '动作栏消息发送失败';
      break;

    default:
      await sendTempMessage('不支持的消息类型', session);
      return false;
  }

  // 发送消息并处理反馈
  if (!feedback) {
    return sendApiRequest(api, messageData, session);
  }

  return sendToMinecraft({
    api,
    data: messageData,
    session,
    successMsg,
    failMsg
  });
}
