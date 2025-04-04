import { Session, Context } from 'koishi'
import { WebSocket, WebSocketServer } from 'ws'
import { Rcon } from 'rcon-client'
import { MTConfig } from './index'

let minecraftSocket: WebSocket | null = null
let wsServer: WebSocketServer | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectCount = 0

/**
 * 注册服务器相关命令
 * @param parent - 父命令对象，用于挂载子命令
 * @param config - MC-Tools 配置对象
 * @returns void
 */
export function registerServerCommands(parent: any, config: MTConfig) {
  const mcserver = parent.subcommand('.server', 'Minecraft 服务器管理')
    .usage('mc.server - Minecraft 服务器相关命令')
    .before(({ session }) => {
      if (!config.connect || !session) return false
      const currentGroup = `${session.platform}:${session.guildId}`
      if (currentGroup !== config.connect) return false
    })
  mcserver.subcommand('.say <message:text>', '发送消息到服务器')
    .usage('mc.server.say <消息> - 发送消息到 Minecraft 服务器')
    .action(async ({ session }, message) => {
      if (!message) return sendTempMessage('请输入消息', session)
      const sender = session.username || session.userId
      if (config.enableWebSocket) {
        const formattedMessage = createMcText(`${sender}: ${message}`)
        const success = await sendMinecraftMessage('chat', formattedMessage, { session, feedback: false })
        if (!success && config.enableRcon) {
          await executeRconCommand(`say ${sender}: ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('消息发送失败', session)
        } else {
          await sendTempMessage('消息发送成功', session)
        }
      } else {
        await executeRconCommand(`say ${sender}: ${message}`, config, session)
      }
    })
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .usage('mc.server.run <命令> - 执行自定义 Minecraft 命令')
    .action(({ session }, command) => {
      if (!command) return sendTempMessage('请输入命令', session)
      executeRconCommand(command, config, session)
    })

  if (config.enableWebSocket) {
    mcserver.subcommand('.broadcast <message:text>', '广播消息到服务器')
      .alias('.bc')
      .usage('mc.server.broadcast <消息> - 以更醒目的方式广播消息')
      .option('color', '-c <color:string> 消息颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '-i 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('strikethrough', '-s 使用删除线')
      .option('obfuscated', '-o 使用混淆效果')
      .option('font', '-f <font:string> 使用自定义字体')
      .option('insertion', '--insert <text:string> 点击插入文本')
      .option('url', '--url <url:string> 点击打开URL')
      .option('command', '--cmd <command:string> 点击执行命令')
      .option('suggest', '--suggest <command:string> 点击提示命令')
      .option('copy', '--copy <text:string> 点击复制文本')
      .option('hoverText', '--hover <text:string> 鼠标悬停显示文本')
      .option('hoverItem', '--item <id:string> 鼠标悬停显示物品')
      .option('hoverEntity', '--entity <id:string> 鼠标悬停显示实体')
      .action(async ({ session, options }, message) => {
        if (!message) return sendTempMessage('请输入消息', session)
        const styles: any = {};
        if (options.color) styles.color = options.color;
        if ('bold' in options) styles.bold = options.bold;
        if ('italic' in options) styles.italic = options.italic;
        if ('underlined' in options) styles.underlined = options.underlined;
        if ('strikethrough' in options) styles.strikethrough = options.strikethrough;
        if ('obfuscated' in options) styles.obfuscated = options.obfuscated;
        if (options.font) styles.font = options.font;
        if (options.insertion) styles.insertion = options.insertion;
        if (options.url) {
          styles.clickEvent = { action: 'open_url', value: options.url };
        } else if (options.command) {
          styles.clickEvent = { action: 'run_command', value: options.command };
        } else if (options.suggest) {
          styles.clickEvent = { action: 'suggest_command', value: options.suggest };
        } else if (options.copy) {
          styles.clickEvent = { action: 'copy_to_clipboard', value: options.copy };
        }
        if (options.hoverText) {
          styles.hoverEvent = {
            action: 'show_text',
            contents: options.hoverText
          };
        } else if (options.hoverItem) {
          styles.hoverEvent = {
            action: 'show_item',
            item: { id: options.hoverItem }
          };
        } else if (options.hoverEntity) {
          styles.hoverEvent = {
            action: 'show_entity',
            entity: { id: options.hoverEntity }
          };
        }
        const hasStyles = Object.keys(styles).length > 0;
        const formattedMessage = hasStyles ? createMcText(message, styles) : message;
        const success = await sendMinecraftMessage('broadcast', formattedMessage, { session, feedback: false })
        if (!success && config.enableRcon) {
          await executeRconCommand(`broadcast ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('广播发送失败', session)
        } else {
          await sendTempMessage('广播发送成功', session)
        }
      })
    mcserver.subcommand('.tell <player:string> <message:text>', '向玩家发送私聊消息')
      .usage('mc.server.tell <玩家> <消息> - 向特定玩家发送私聊消息')
      .option('color', '-c <color:string> 消息颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '-i 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('strikethrough', '-s 使用删除线')
      .option('obfuscated', '-o 使用混淆效果')
      .option('font', '-f <font:string> 使用自定义字体')
      .option('url', '--url <url:string> 点击打开URL')
      .option('command', '--cmd <command:string> 点击执行命令')
      .option('suggest', '--suggest <command:string> 点击提示命令')
      .option('copy', '--copy <text:string> 点击复制文本')
      .option('hoverText', '--hover <text:string> 鼠标悬停显示文本')
      .action(async ({ session, options }, player, message) => {
        if (!player || player.length === 0) return sendTempMessage('请指定玩家', session)
        if (!message) return sendTempMessage('请输入消息', session)
        const sender = session.username || session.userId
        const styles: any = {};
        if (options.color) styles.color = options.color;
        if ('bold' in options) styles.bold = options.bold;
        if ('italic' in options) styles.italic = options.italic;
        if ('underlined' in options) styles.underlined = options.underlined;
        if ('strikethrough' in options) styles.strikethrough = options.strikethrough;
        if ('obfuscated' in options) styles.obfuscated = options.obfuscated;
        if (options.font) styles.font = options.font;
        if (options.url) {
          styles.clickEvent = { action: 'open_url', value: options.url };
        } else if (options.command) {
          styles.clickEvent = { action: 'run_command', value: options.command };
        } else if (options.suggest) {
          styles.clickEvent = { action: 'suggest_command', value: options.suggest };
        } else if (options.copy) {
          styles.clickEvent = { action: 'copy_to_clipboard', value: options.copy };
        }
        if (options.hoverText) {
          styles.hoverEvent = {
            action: 'show_text',
            contents: options.hoverText
          };
        }
        const messageText = `来自 ${sender} 的消息: ${message}`;
        const hasStyles = Object.keys(styles).length > 0;
        const formattedMsg = hasStyles ? createMcText(messageText, styles) : messageText;
        const success = await sendMinecraftMessage('whisper', formattedMsg, {
          player,
          session,
          feedback: false
        })
        if (!success && config.enableRcon) {
          await executeRconCommand(`tell ${player} ${sender}: ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('私聊消息发送失败', session)
        } else {
          await sendTempMessage('私聊消息发送成功', session)
        }
      })
    mcserver.subcommand('.title <title:text> [subtitle:text]', '发送标题到服务器')
      .usage('mc.server.title <标题> [副标题] - 向所有玩家发送标题')
      .option('fadein', '-i <time:number> 淡入时间')
      .option('stay', '-s <time:number> 停留时间')
      .option('fadeout', '-o <time:number> 淡出时间')
      .option('color', '-c <color:string> 标题颜色')
      .option('subcolor', '-sc <color:string> 副标题颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '--italic 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('subbold', '--sb 副标题使用粗体')
      .option('subitalic', '--si 副标题使用斜体')
      .option('subunderlined', '--su 副标题使用下划线')
      .action(async ({ session, options }, title, subtitle) => {
        if (!title) return sendTempMessage('请输入标题', session)
        const titleStyles: any = {};
        if (options.color) titleStyles.color = options.color;
        if ('bold' in options) titleStyles.bold = options.bold;
        if ('italic' in options) titleStyles.italic = options.italic;
        if ('underlined' in options) titleStyles.underlined = options.underlined;
        const subtitleStyles: any = {};
        if (options.subcolor) subtitleStyles.color = options.subcolor;
        if ('subbold' in options) subtitleStyles.bold = options.subbold;
        if ('subitalic' in options) subtitleStyles.italic = options.subitalic;
        if ('subunderlined' in options) subtitleStyles.underlined = options.subunderlined;
        const titleText = Object.keys(titleStyles).length > 0 ?
          createMcText(title, titleStyles) : title;
        const subtitleText = subtitle && Object.keys(subtitleStyles).length > 0 ?
          createMcText(subtitle, subtitleStyles) : subtitle || '';
        const fadein = options.fadein !== undefined ? options.fadein : 10;
        const stay = options.stay !== undefined ? options.stay : 70;
        const fadeout = options.fadeout !== undefined ? options.fadeout : 20;
        const success = await sendMinecraftMessage('title', titleText, {
          subtitle: subtitleText,
          fadein,
          stay,
          fadeout,
          session,
          feedback: false
        })
        if (!success && config.enableRcon) {
          const titleColor = options.color || 'gold';
          const subtitleColor = options.subcolor || 'yellow';
          await executeRconCommand(`title @a title {"text":"${title}","color":"${titleColor}"}`, config, session)
          if (subtitle) {
            await executeRconCommand(`title @a subtitle {"text":"${subtitle}","color":"${subtitleColor}"}`, config, session)
          }
          await executeRconCommand(`title @a times ${fadein} ${stay} ${fadeout}`, config, session)
          await sendTempMessage('标题发送成功', session)
        } else if (!success) {
          await sendTempMessage('标题发送失败', session)
        } else {
          await sendTempMessage('标题发送成功', session)
        }
      })
    mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
      .alias('.ab')
      .usage('mc.server.actionbar <消息> - 发送动作栏消息到服务器')
      .option('color', '-c <color:string> 消息颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '-i 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('strikethrough', '-s 使用删除线')
      .option('obfuscated', '-o 使用混淆效果')
      .action(async ({ session, options }, message) => {
        if (!message) return sendTempMessage('请输入消息', session)
        const styles: any = {};
        if (options.color) styles.color = options.color;
        if ('bold' in options) styles.bold = options.bold;
        if ('italic' in options) styles.italic = options.italic;
        if ('underlined' in options) styles.underlined = options.underlined;
        if ('strikethrough' in options) styles.strikethrough = options.strikethrough;
        if ('obfuscated' in options) styles.obfuscated = options.obfuscated;
        const hasStyles = Object.keys(styles).length > 0;
        const actionbarText = hasStyles ? createMcText(message, styles) : message;
        const success = await sendMinecraftMessage('actionbar', actionbarText, { session, feedback: false })
        if (!success && config.enableRcon) {
          const color = options.color || 'white';
          const bold = options.bold || false;
          await executeRconCommand(`title @a actionbar {"text":"${message}","color":"${color}","bold":${bold}}`, config, session)
          await sendTempMessage('动作栏消息发送成功', session)
        } else if (!success) {
          await sendTempMessage('动作栏消息发送失败', session)
        } else {
          await sendTempMessage('动作栏消息发送成功', session)
        }
      })
    mcserver.subcommand('.json <jsonText:text>', '发送JSON格式消息')
      .usage('mc.server.json <JSON文本> - 发送复杂的JSON格式消息')
      .option('type', '-t <type:string> 消息类型 (chat/broadcast/whisper/title/actionbar)')
      .option('player', '-p <player:string> 玩家名称或UUID (whisper类型使用)')
      .action(async ({ session, options }, jsonText) => {
        if (!jsonText) return sendTempMessage('请输入消息', session)
        try {
          const messageObj = JSON.parse(jsonText);
          const msgType = options.type as 'chat' | 'broadcast' | 'whisper' | 'title' | 'actionbar' || 'broadcast';
          let success = false;
          if (msgType === 'whisper' && !options.player) {
            return sendTempMessage('请指定玩家', session);
          }
          success = await sendMinecraftMessage(msgType, messageObj, {
            player: options.player,
            session,
            feedback: false
          });
          if (!success) {
            return sendTempMessage('消息发送失败', session);
          }
          await sendTempMessage(`消息发送成功`, session);
        } catch (error) {
          await sendTempMessage(`JSON解析失败: ${error.message}`, session);
        }
      })
  }
}

/**
 * 发送临时消息
 * @param message - 要发送的消息内容
 * @param session - Koishi会话对象，用于发送和删除消息
 * @returns 一个Promise，完成后表示消息已发送（会在10秒后自动删除）
 */
async function sendTempMessage(message: string, session?: Session): Promise<void> {
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
async function executeRconCommand(
  command: string,
  config: MTConfig,
  session?: Session
): Promise<void> {
  if (!command) return sendTempMessage('请输入命令', session)
  if (!config.rconPassword) return sendTempMessage('请配置RCON密码', session)
  const [serverHost, portStr] = (config.rconAddress || '').split(':')
  const port = portStr ? parseInt(portStr) : 25575
  if (!serverHost) return sendTempMessage('请配置RCON地址', session)
  if (isNaN(port)) return sendTempMessage('请正确配置RCON端口', session)
  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.rconPassword
    })
    const result = await rcon.send(command)
    await rcon.end()
    return sendTempMessage(result ? `命令执行成功: ${result}` : '命令执行成功', session)
  } catch (error) {
    return error.message
  }
}

/**
 * 初始化WebSocket通信
 * @param ctx - Koishi上下文对象
 * @param config - MC-Tools配置对象
 */
export function initWebSocket(ctx: Context, config: MTConfig) {
  if (!config.enableWebSocket) return
  if (config.websocketMode === 'client') {
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
  if (!config.connect) return
  const [platform, channelId] = config.connect.split(':')
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
  const [host, portStr] = config.websocketAddress.split(':')
  const port = portStr ? parseInt(portStr) : 8080
  const url = `ws://${host}:${port}/minecraft/ws`
  const headers = {
    'Authorization': `Bearer ${config.websocketToken}`,
    'x-self-name': config.name,
    'x-client-origin': 'koishi'
  }
  try {
    minecraftSocket = new WebSocket(url, { headers })
    minecraftSocket.on('open', () => {
      logger.info(`WebSocket客户端已连接: ${url}`)
      reconnectCount = 0
      sendGroupNotification(ctx, config, `已连接到Minecraft服务器 ${config.name}`)
      sendWelcomeMessage(minecraftSocket)
    })
    minecraftSocket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.event_name && config.connect) {
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
        sendGroupNotification(ctx, config, `Minecraft服务器 ${config.name} 已断开连接`)
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
  const [host, portStr] = config.websocketAddress.split(':')
  const port = portStr ? parseInt(portStr) : 8080
  try {
    wsServer = new WebSocketServer({ host, port })
    logger.info(`WebSocket服务端已启动: ${host}:${port}`)
    wsServer.on('connection', (ws, req) => {
      const auth = req.headers.authorization
      const selfName = req.headers['x-self-name']
      const clientOrigin = req.headers['x-client-origin']
      if (!auth || auth !== `Bearer ${config.websocketToken}` ||
          !selfName || selfName !== config.name) {
        ws.close(1008, 'Authorization failed')
        return
      }
      logger.info(`已连接到Minecraft服务器 ${clientOrigin || '未知'}`)
      minecraftSocket = ws
      sendGroupNotification(ctx, config, `已连接到Minecraft服务器 ${config.name}`)
      sendWelcomeMessage(ws)
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.event_name && config.connect) {
            handleMinecraftEvent(ctx, message, config)
          }
        } catch (err) {
          logger.error('WebSocket消息解析失败:', err)
        }
      })
      ws.on('close', () => {
        logger.warn('WebSocket客户端已断开')
        minecraftSocket = null
        sendGroupNotification(ctx, config, `Minecraft服务器 ${config.name} 已断开连接`)
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
  const [platform, channelId] = config.connect.split(':')
  try {
    const serverName = message.server_name || config.name
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
function createMcText(text: string, styles: {
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
 * 发送API请求到Minecraft服务器
 * @param api - API名称
 * @param data - 请求数据
 * @param session - Koishi会话对象，用于反馈结果
 * @returns 请求是否发送成功
 */
async function sendApiRequest(
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
async function sendMinecraftMessage(
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