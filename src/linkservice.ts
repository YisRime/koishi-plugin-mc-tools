import { Session } from 'koishi'
import { Rcon } from 'rcon-client'
import { MTConfig } from './index'
import { WebSocket, WebSocketServer } from 'ws'
import { Context } from 'koishi'

export let minecraftSocket: WebSocket | null = null
let wsServer: WebSocketServer | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectCount = 0

/**
 * 发送临时消息
 * @param message - 要发送的消息内容
 * @param session - Koishi会话对象，用于发送和删除消息
 * @returns 一个Promise，完成后表示消息已发送（会在10秒后自动删除）
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
 * @param command - 要执行的Minecraft命令
 * @param config - MC-Tools配置对象
 * @param session - Koishi会话对象，用于反馈执行结果
 * @returns 一个Promise，完成后表示命令已执行
 */
export async function executeRconCommand(
  command: string,
  config: MTConfig,
  session?: Session
): Promise<void> {
  if (!command) return sendTempMessage('请输入命令', session)
  if (!config.link.rconPassword) return sendTempMessage('请配置RCON密码', session)
  const [serverHost, portStr] = (config.link.rconAddress || '').split(':')
  const port = portStr ? parseInt(portStr) : 25575
  if (!serverHost) return sendTempMessage('请配置RCON地址', session)
  if (isNaN(port)) return sendTempMessage('请正确配置RCON端口', session)
  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.link.rconPassword
    })
    const result = await rcon.send(command)
    await rcon.end()
    return sendTempMessage(result ? `命令执行成功: ${result}` : '命令执行成功', session)
  } catch (error) {
    return error.message
  }
}

/**
 * 检查群组是否有权限
 * @param session - Koishi会话对象
 * @param groupId - 要检查的群组ID
 * @returns 如果当前会话的群组与配置的群组匹配，则返回true
 */
export function hasGroupPermission(session, groupId: string): boolean {
  if (!groupId || !session) return false
  const currentGroup = `${session.platform}:${session.guildId}`
  return currentGroup === groupId
}

/**
 * 初始化WebSocket通信
 * @param ctx - Koishi上下文对象
 * @param config - MC-Tools配置对象
 */
export function initWebSocket(ctx: Context, config: MTConfig) {
  if (!config.link.enableWebSocket) return
  if (config.link.websocketMode === 'client') {
    connectAsClient(ctx, config)
  } else {
    startWebSocketServer(ctx, config)
  }
}

/**
 * 向群组发送通知
 * @param ctx - Koishi上下文对象
 * @param config - MC-Tools配置对象
 * @param message - 要发送的通知消息
 */
function sendGroupNotification(ctx: Context, config: MTConfig, message: string) {
  if (!config.link.group) return
  const [platform, channelId] = config.link.group.split(':')
  ctx.bots[platform]?.sendMessage(channelId, message)
}

/**
 * 发送Minecraft欢迎消息
 * @param socket - WebSocket连接对象
 */
function sendWelcomeMessage(socket: WebSocket) {
  const message = {
    api: "send_msg",
    data: {
      message: {
        type: "text",
        data: { text: `[MC-Tools]连接成功！` }
      }
    }
  }
  socket.send(JSON.stringify(message))
}

/**
 * 作为客户端连接到WebSocket服务端
 * @param ctx - Koishi上下文对象
 * @param config - MC-Tools配置对象
 */
function connectAsClient(ctx: Context, config: MTConfig) {
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
      logger.info(`WebSocket客户端已连接: ${url}`)
      reconnectCount = 0
      sendGroupNotification(ctx, config, `已连接到Minecraft服务器 ${config.link.name}`)
      sendWelcomeMessage(minecraftSocket)
    })
    minecraftSocket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.event_name && config.link.group) {
          handleMinecraftEvent(ctx, message, config)
        }
      } catch (err) {
        logger.error('WebSocket消息解析失败:', err)
      }
    })
    minecraftSocket.on('error', (err) => {
      logger.error('WebSocket客户端错误:', err)
    })
    minecraftSocket.on('close', () => {
      logger.warn('WebSocket服务端已断开')
      if (reconnectCount < 10) {
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => {
          reconnectCount++
          connectAsClient(ctx, config)
        }, 5000 * Math.min(reconnectCount + 1, 5))
      } else {
        sendGroupNotification(ctx, config, `Minecraft服务器 ${config.link.name} 已断开连接`)
      }
    })
  } catch (err) {
    logger.error('WebSocket客户端创建失败:', err)
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
 * 启动WebSocket服务端
 * @param ctx - Koishi上下文对象
 * @param config - MC-Tools配置对象
 */
function startWebSocketServer(ctx: Context, config: MTConfig) {
  const logger = ctx.logger('mc-tools:ws')
  const [host, portStr] = config.link.websocketAddress.split(':')
  const port = portStr ? parseInt(portStr) : 8080
  try {
    wsServer = new WebSocketServer({ host, port })
    logger.info(`WebSocket服务端已启动: ${host}:${port}`)
    wsServer.on('connection', (ws, req) => {
      const auth = req.headers.authorization
      const selfName = req.headers['x-self-name']
      const clientOrigin = req.headers['x-client-origin']
      if (!auth || auth !== `Bearer ${config.link.websocketToken}` ||
          !selfName || selfName !== config.link.name) {
        ws.close(1008, 'Authorization failed')
        return
      }
      logger.info(`已连接到Minecraft服务器 ${clientOrigin || '未知'}`)
      minecraftSocket = ws
      sendGroupNotification(ctx, config, `已连接到Minecraft服务器 ${config.link.name}`)
      sendWelcomeMessage(ws)
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.event_name && config.link.group) {
            handleMinecraftEvent(ctx, message, config)
          }
        } catch (err) {
          logger.error('WebSocket消息解析失败:', err)
        }
      })
      ws.on('close', () => {
        logger.warn('WebSocket客户端已断开')
        minecraftSocket = null
        sendGroupNotification(ctx, config, `Minecraft服务器 ${config.link.name} 已断开连接`)
      })
      ws.on('error', (err) => {
        logger.error('WebSocket连接错误:', err)
      })
    })
    wsServer.on('error', (err) => {
      logger.error('WebSocket服务端错误:', err)
    })
  } catch (err) {
    logger.error('WebSocket服务端启动失败:', err)
  }
}

/**
 * 处理来自Minecraft的事件
 * @param ctx - Koishi上下文对象
 * @param message - 从Minecraft服务器接收的消息对象
 * @param config - MC-Tools配置对象
 */
function handleMinecraftEvent(ctx: Context, message: any, config: MTConfig) {
  const logger = ctx.logger('mc-tools:ws')
  const [platform, channelId] = config.link.group.split(':')
  try {
    const serverName = message.server_name || config.link.name
    const eventName = message.event_name || ''
    let content = ''
    // 获取玩家位置信息
    let locationInfo = ''
    if (message.player) {
      const player = message.player
      if (player.block_x !== undefined && player.block_y !== undefined && player.block_z !== undefined) {
        locationInfo = ` [位置: ${player.block_x}, ${player.block_y}, ${player.block_z}]`
      }
    }
    // 获取玩家游戏模式
    let gameModeInfo = ''
    if (message.player) {
      if (message.player.game_mode) {
        gameModeInfo = ` [模式: ${message.player.game_mode}]`
      } else if (message.player.is_creative !== undefined) {
        let mode = message.player.is_spectator ? '旁观者' :
                   message.player.is_creative ? '创造' : '生存'
        gameModeInfo = ` [模式: ${mode}]`
      }
    }
    switch (eventName) {
      case 'AsyncPlayerChatEvent':         // Spigot
      case 'ServerMessageEvent':           // Fabric
      case 'ServerChatEvent':              // Forge
      case 'NeoServerChatEvent':           // NeoForge
      case 'MinecraftPlayerChatEvent':     // 原版
      case 'BaseChatEvent':                // 其他
      case 'VelocityPlayerChatEvent':      // Velocity
        content = `[${serverName}] ${message.player?.nickname || '服务器'}: ${message.message || ''}`
        break
      case 'PlayerCommandPreprocessEvent':  // Spigot
      case 'ServerCommandMessageEvent':     // Fabric
      case 'CommandEvent':                  // Forge
      case 'NeoCommandEvent':               // NeoForge
      case 'VelocityCommandExecuteEvent':   // Velocity
        const cmd = message.message?.trim() || ''
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 在 ${locationInfo} 执行了命令: ${cmd}`
        break
      case 'PlayerJoinEvent':                     // Spigot
      case 'ServerPlayConnectionJoinEvent':       // Fabric
      case 'PlayerLoggedInEvent':                 // Forge
      case 'NeoPlayerLoggedInEvent':              // NeoForge
      case 'MinecraftPlayerJoinEvent':            // 原版
      case 'BaseJoinEvent':                       // 其他
      case 'VelocityLoginEvent':                  // Velocity
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 在 ${locationInfo} 加入了游戏`
        if (message.player) {
          if (message.player.display_name &&
              message.player.display_name !== message.player.nickname) {
            content += ` (显示名: ${message.player.display_name})`
          }
          content += gameModeInfo + locationInfo
          if (message.player.ip || message.player.ipAddress || message.player.address) {
            const ip = message.player.ip || message.player.ipAddress || message.player.address
            content += ` [IP: ${ip}]`
          }
        }
        break
      case 'PlayerQuitEvent':                     // Spigot
      case 'ServerPlayConnectionDisconnectEvent': // Fabric
      case 'PlayerLoggedOutEvent':                // Forge
      case 'NeoPlayerLoggedOutEvent':             // NeoForge
      case 'MinecraftPlayerQuitEvent':            // 原版
      case 'BaseQuitEvent':                       // 其他
      case 'VelocityDisconnectEvent':             // Velocity
        content = `[${serverName}] ${message.player?.nickname || '玩家'} 在 ${locationInfo} 离开了游戏`
        break
      case 'PlayerDeathEvent':                     // Spigot/Forge
      case 'NeoPlayerDeathEvent':                  // NeoForge
      case 'ServerLivingEntityAfterDeathEvent':    // Fabric
      case 'BaseDeathEvent':                       // 其他
        if (message.message) {
          content = `[${serverName}] ${message.message}`
        } else {
          content = `[${serverName}] ${message.player?.nickname || '玩家'} 在 ${locationInfo} 死亡了`
        }
        break
      default:
        if (message.message) {
          content = `[${serverName}] ${message.message}`
        }
    }
    if (content) {
      ctx.bots[platform]?.sendMessage(channelId, content)
    }
  } catch (err) {
    logger.error('处理事件失败:', err)
  }
}

/**
 * 清理WebSocket连接
 * 在插件卸载或重启时调用
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
 * @param text - 文本内容
 * @param styles - 样式选项对象，包含颜色、格式、交互事件等
 * @returns 格式化后的文本组件对象
 */
export function createMcText(text: string, styles: {
  color?: string,
  font?: string,
  bold?: boolean,
  italic?: boolean,
  underlined?: boolean,
  strikethrough?: boolean,
  obfuscated?: boolean,
  insertion?: string,
  clickEvent?: {
    action: 'open_url' | 'open_file' | 'run_command' | 'suggest_command' | 'change_page' | 'copy_to_clipboard',
    value: string
  },
  hoverEvent?: {
    action: 'show_text',
    text?: any
  }
} = {}): any {
  const data: any = { text };
  if (styles.color && styles.color.trim() !== '') data.color = styles.color;
  if (styles.font) data.font = styles.font;
  if ('bold' in styles) data.bold = styles.bold;
  if ('italic' in styles) data.italic = styles.italic;
  if ('underlined' in styles) data.underlined = styles.underlined;
  if ('strikethrough' in styles) data.strikethrough = styles.strikethrough;
  if ('obfuscated' in styles) data.obfuscated = styles.obfuscated;
  if (styles.insertion) data.insertion = styles.insertion;
  if (styles.clickEvent) {
    data.click_event = {
      action: styles.clickEvent.action,
      value: styles.clickEvent.value
    };
  }
  if (styles.hoverEvent) {
    const hoverEvent: any = {
      action: styles.hoverEvent.action
    };
    if (styles.hoverEvent.action === 'show_text' && styles.hoverEvent.text) {
      hoverEvent.text = styles.hoverEvent.text;
    }
    if (Object.keys(hoverEvent).length > 1) {
      data.hover_event = hoverEvent;
    }
  }
  return {
    type: 'text',
    data
  };
}

/**
 * 创建悬停文本事件
 * @param text - 悬停时显示的文本或文本组件
 * @returns 悬停事件对象
 */
export function createHoverTextEvent(text: string | any) {
  return {
    action: 'show_text',
    text: typeof text === 'string' ? [{
      text: text,
      color: null,
      font: null,
      bold: false,
      italic: false,
      underlined: false,
      strikethrough: false,
      obfuscated: false,
      insertion: null
    }] : text
  };
}

/**
 * 发送API请求到Minecraft服务器
 * @param api - API名称
 * @param data - 请求数据
 * @param session - Koishi会话对象，用于反馈结果
 * @returns 请求是否发送成功
 */
export async function sendApiRequest(
  api: string,
  data: any,
  session?: Session
): Promise<boolean> {
  if (!minecraftSocket) {
    await sendTempMessage('WebSocket 未连接', session)
    return false
  }
  try {
    const request = { api, data }
    minecraftSocket.send(JSON.stringify(request))
    return true
  } catch (error) {
    await sendTempMessage(`发送消息失败: ${error.message}`, session)
    return false
  }
}

/**
 * 通用发送消息到Minecraft服务器函数
 * 整合了所有消息发送功能
 * @param messageType - 消息类型，可以是chat、broadcast、whisper、title或actionbar
 * @param message - 消息内容，可以是字符串或文本组件
 * @param options - 附加选项，如玩家名称、副标题、显示时间等
 * @returns 消息是否发送成功
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
    fadein,
    stay,
    fadeout,
    session,
    feedback = true
  } = options;
  let api: string;
  let messageData: any = {};
  let successMsg: string;
  let failMsg: string;
  const formattedMessage = (() => {
    if (typeof message === 'string') {
      return message;
    }
    if (!Array.isArray(message) && message.type === 'text') {
      const data = message.data || {};
      const hasStyles = data.color || data.bold || data.italic ||
                        data.underlined || data.strikethrough || data.obfuscated ||
                        data.insertion || data.click_event || data.hover_event;
      if (!hasStyles) {
        return data.text;
      }
    }
    if (Array.isArray(message) && message.length === 1 &&
        message[0].type === 'text') {
      const data = message[0].data || {};
      const hasStyles = data.color || data.bold || data.italic ||
                        data.underlined || data.strikethrough || data.obfuscated ||
                        data.insertion || data.click_event || data.hover_event;
      if (!hasStyles) {
        return data.text;
      }
    }
    return Array.isArray(message) ? message : [message];
  })();
  // 根据消息类型构建API请求
  switch (messageType) {
    case 'chat':
      api = 'send_msg';
      messageData.message = formattedMessage;
      successMsg = '消息发送成功';
      failMsg = '消息发送失败';
      break;
    case 'broadcast':
      api = 'broadcast';
      messageData.message = formattedMessage;
      successMsg = '广播发送成功';
      failMsg = '广播发送失败';
      break;
    case 'whisper':
      api = 'send_private_msg';
      messageData.message = formattedMessage;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player);
      if (isUUID) {
        messageData.uuid = player;
      } else {
        messageData.nickname = player;
      }
      successMsg = '私聊消息发送成功';
      failMsg = '私聊消息发送失败';
      break;
    case 'title':
      api = 'send_title';
      messageData.title = formattedMessage;
      if (subtitle) {
        messageData.subtitle = (() => {
          if (typeof subtitle === 'string') {
            return subtitle;
          }
          if (!Array.isArray(subtitle) && subtitle.type === 'text') {
            const data = subtitle.data || {};
            const hasStyles = data.color || data.bold || data.italic ||
                              data.underlined || data.strikethrough || data.obfuscated ||
                              data.insertion || data.click_event || data.hover_event;

            if (!hasStyles) {
              return data.text;
            }
          }
          if (Array.isArray(subtitle) && subtitle.length === 1 &&
              subtitle[0].type === 'text') {
            const data = subtitle[0].data || {};
            const hasStyles = data.color || data.bold || data.italic ||
                              data.underlined || data.strikethrough || data.obfuscated ||
                              data.insertion || data.click_event || data.hover_event;

            if (!hasStyles) {
              return data.text;
            }
          }
          return Array.isArray(subtitle) ? subtitle : [subtitle];
        })();
      }
      if (fadein !== undefined) messageData.fadein = fadein;
      if (stay !== undefined) messageData.stay = stay;
      if (fadeout !== undefined) messageData.fadeout = fadeout;
      successMsg = '标题发送成功';
      failMsg = '标题发送失败';
      break;
    case 'actionbar':
      api = 'send_actionbar';
      messageData.message = formattedMessage;
      successMsg = '动作栏消息发送成功';
      failMsg = '动作栏消息发送失败';
      break;
    default:
      await sendTempMessage('不支持的消息类型', session);
      return false;
  }
  if (!feedback) {
    return sendApiRequest(api, messageData, session);
  }
  const success = await sendApiRequest(api, messageData, session);
  if (session) {
    await sendTempMessage(success ? successMsg : failMsg, session);
  }
  return success;
}
