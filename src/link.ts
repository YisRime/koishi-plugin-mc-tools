import { Context } from 'koishi'
import { MinecraftToolsConfig } from './index'
import * as LinkService from './linkservice'
import { Rcon } from 'rcon-client'

/**
 * 注册Minecraft服务器管理相关命令
 * @param parent 父命令
 * @param config 插件配置
 * @param ctx Koishi上下文
 */
export function registerServerCommands(parent: any, config: MinecraftToolsConfig, ctx: Context) {

  /**
   * 测试RCON连接状态
   * @returns 连接状态字符串
   */
  async function testRconConnection() {
    if (!config.link.enableRcon) return '未启用'
    if (!config.link.rcon.password) return '未配置密码'

    try {
      const [host, portStr] = config.link.rcon.address.split(':')
      const port = parseInt(portStr)
      const rcon = await Rcon.connect({
        host, port, password: config.link.rcon.password,
        timeout: 3000 // 设置较短的超时时间避免长时间等待
      })
      await rcon.end()
      return '√'
    } catch (error) {
      return '连接失败'
    }
  }

  /**
   * 自动检查服务器连接方式
   * 1. 检查是否在关联群组中
   * 2. 检查连接方式(WebSocket或RCON)
   */
  const checkServerAndConnection = async ({ session }) => {
    // 检查是否在关联群组
    if (config.link.group && session?.channelId) {
      const channelKey = `${session.platform}:${session.channelId}`
      if (config.link.group !== channelKey) {
        // 非关联群组也允许使用，只是给出提示
        ctx.logger.debug(`当前会话 ${channelKey} 不是服务器关联的群组 ${config.link.group}`)
      }
    }

    // 保存服务器配置到会话中
    session.serverConfig = config.link

    // 确定连接方式 - 优先WebSocket，如不可用则尝试RCON
    let connectionTypes = []

    if (config.link.enableWebSocket) {
      // 检查WebSocket连接状态
      const isConnected = (LinkService.serverConnection.ws &&
                          LinkService.serverConnection.ws.readyState === 1) ||
                          LinkService.serverConnection.clients.size > 0;

      if (isConnected) {
        connectionTypes.push('ws')
        ctx.logger.debug(`[${config.link.name}] 检测到可用的WebSocket连接`)
      } else {
        ctx.logger.debug(`[${config.link.name}] WebSocket连接不可用`)
      }
    }

    if (config.link.enableRcon) {
      connectionTypes.push('rcon')
      ctx.logger.debug(`[${config.link.name}] 检测到RCON配置`)
    }

    if (connectionTypes.length === 0) {
      return {
        pass: false,
        message: `服务器 ${config.link.name} 未配置可用的连接方式或连接未建立`
      }
    }

    // 保存所有可用连接类型到会话，优先使用WebSocket
    session.connectionTypes = connectionTypes
    session.connectionType = connectionTypes[0]
    ctx.logger.debug(`[${config.link.name}] 使用连接方式: ${session.connectionType}`)

    return { pass: true }
  }

  /**
   * 在WebSocket失败时尝试回退到RCON
   * @param session 当前会话
   * @param operation WebSocket操作失败时的回调
   * @param fallback RCON回退操作的回调
   */
  async function tryWithFallback(session, operation, fallback) {
    const { connectionTypes } = session

    // 首先尝试主要连接方式
    try {
      const result = await operation()
      return typeof result === 'object' ? JSON.stringify(result) : result
    } catch (error) {
      ctx.logger.warn(`[${config.link.name}] 主要连接方式失败: ${error.message}, 尝试回退方式`)

      // 尝试回退到RCON (如果可用且不是当前连接方式)
      if (connectionTypes.includes('rcon') && session.connectionType !== 'rcon') {
        session.connectionType = 'rcon'
        try {
          const result = await fallback()
          return typeof result === 'object' ? JSON.stringify(result) : result
        } catch (fallbackError) {
          throw new Error(`所有连接方式都失败: ${error.message}, 回退方式: ${fallbackError.message}`)
        }
      }

      // 如果没有回退方式或回退方式也失败
      throw error
    }
  }

  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .before(checkServerAndConnection)
    .action(async ({ session }) => {
      // 获取状态信息
      const statusMessage = ['Minecraft 服务器状态:']

      // 测试RCON连接
      const rconStatus = await testRconConnection()

      // 检查WebSocket连接状态
      let wsStatus = '未启用'
      if (config.link.enableWebSocket) {
        const isConnected = (LinkService.serverConnection.ws &&
                            LinkService.serverConnection.ws.readyState === 1) ||
                            LinkService.serverConnection.clients.size > 0;
        wsStatus = isConnected ? config.link.websocket.mode : 'Connecting'
      }

      statusMessage.push(`[${config.link.name}] RCON:${rconStatus} WebSocket:${wsStatus}`)

      // 如果WebSocket已启用但未连接，尝试重连
      if (config.link.enableWebSocket && wsStatus === 'Connecting') {
        statusMessage.push(`\n正在重新连接服务器...`)
        LinkService.cleanupWebSocket()

        if (config.link.websocket.mode === 'client') {
          LinkService.initWebSocketClient(ctx, config)
        } else {
          LinkService.initWebSocketServer(ctx, config)
        }
      }

      // 获取具体的服务器状态
      if (config.link.enableWebSocket && wsStatus !== '未启用' && wsStatus !== 'Connecting') {
        try {
          const response = await LinkService.sendRequestAndWaitResponse('get_server_status', {})

          if (response.data) {
            const {
              server_name = config.link.name,
              version,
              online_players = 0,
              max_players = '?',
              tps,
              memory_used,
              memory_total,
              uptime
            } = response.data;

            statusMessage.push(`\n[${server_name}] 详细信息:`);

            // 版本和玩家数
            const infoItems = [];
            if (version) infoItems.push(version);
            infoItems.push(`玩家: ${online_players}/${max_players}`);
            if (tps) infoItems.push(`TPS: ${tps}`);
            if (infoItems.length > 0) {
              statusMessage.push(infoItems.join(' | '));
            }

            // 内存使用
            if (memory_used || memory_total) {
              const memParts = [];
              if (memory_used) memParts.push(`${(memory_used / 1024 / 1024).toFixed(2)}MB`);
              if (memory_total) memParts.push(`${(memory_total / 1024 / 1024).toFixed(2)}MB`);
              statusMessage.push(`内存: ${memParts.join('/')}`);
            }

            // 运行时长
            if (uptime) {
              const hours = Math.floor(uptime / 3600);
              const minutes = Math.floor((uptime % 3600) / 60);
              statusMessage.push(`运行时长: ${hours}时${minutes}分`);
            }

            // 获取在线玩家列表
            try {
              const playerResponse = await LinkService.sendRequestAndWaitResponse('get_players', {})
              if (playerResponse.data && playerResponse.data.players && playerResponse.data.players.length > 0) {
                statusMessage.push('\n在线玩家:');
                playerResponse.data.players.slice(0, 10).forEach((player: any) => {
                  const name = player.nickname || player.display_name || player.name
                  statusMessage.push(`- ${name}`);
                });

                if (playerResponse.data.players.length > 10) {
                  statusMessage.push(`... 共${playerResponse.data.players.length}名玩家`);
                }
              }
            } catch (playerError) {
              // 获取玩家列表失败，忽略错误
            }
          }
        } catch (wsError) {
          // 尝试RCON
          if (config.link.enableRcon) {
            await fallbackToRcon();
          }
        }
      } else if (config.link.enableRcon) {
        await fallbackToRcon();
      }

      async function fallbackToRcon() {
        try {
          const [host, portStr] = config.link.rcon.address.split(':')
          const port = parseInt(portStr)
          const rcon = await Rcon.connect({
            host, port, password: config.link.rcon.password
          })
          const listResult = await rcon.send('list')
          await rcon.end()
          statusMessage.push(`\n[${config.link.name}] RCON状态:\n${listResult}`)
        } catch (rconError) {
          statusMessage.push(`\n[${config.link.name}] RCON连接失败: ${rconError.message}`)
        }
      }

      return statusMessage.join('\n')
    })

  // 定义消息发送相关命令
  mcserver.subcommand('.say <message:text>', '发送消息')
    .action(async ({ session }, message) => {
      // 确保会话和服务器配置存在
      if (!session || !session.serverConfig) {
        return `服务器配置丢失，无法发送消息`
      }

      try {
        const result = await tryWithFallback(
          session,
          async () => {
            if (session.connectionType === 'ws') {
              const userIdentifier = session.username || session.userId
              const formattedMsg = `${userIdentifier}: ${message}`
              return await LinkService.sendMinecraftMessage('text', {
                message: formattedMsg
              }, `[${session.serverConfig.name}] 消息已发送`)
            } else {
              throw new Error('跳过WebSocket尝试')
            }
          },
          async () => {
            // RCON回退方式
            const userIdentifier = session.username || session.userId
            return await LinkService.executeRconCommand(
              `say ${userIdentifier}: ${message}`,
              config,
              session
            )
          }
        )
        return String(result)
      } catch (error) {
        // 安全访问serverConfig
        const serverName = session.serverConfig?.name || '未知服务器'
        return `[${serverName}] 消息发送失败: ${error.message}`
      }
    })

  // 同样的修复应用于其他子命令，确保始终返回字符串
  mcserver.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .action(async ({ session }, player, message) => {
      try {
        const result = await tryWithFallback(
          session,
          async () => {
            if (session.connectionType === 'ws') {
              const userIdentifier = session.username || session.userId
              const formattedMsg = `${userIdentifier}: ${message}`
              return await LinkService.sendMinecraftMessage('private', {
                player,
                message: formattedMsg
              }, `[${session.serverConfig.name}] 私聊消息已发送给 ${player}`)
            } else {
              throw new Error('跳过WebSocket尝试')
            }
          },
          async () => {
            // RCON回退方式
            const userIdentifier = session.username || session.userId
            return await LinkService.executeRconCommand(
              `tell ${player} ${userIdentifier}: ${message}`,
              config,
              session
            )
          }
        )
        return String(result)
      } catch (error) {
        return `私聊消息发送失败: ${error.message}`
      }
    })

  // 为所有其他子命令添加相同的 String() 处理来确保返回字符串
  // 修改示例：其他命令也应该使用类似的方式将结果转换为字符串

  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
    .option('bold', '-b 粗体显示')
    .option('italic', '-i 斜体显示')
    .option('underline', '-u 下划线显示')
    .action(async ({ session, options }, message) => {
      try {
        const result = await tryWithFallback(
          session,
          async () => {
            if (session.connectionType === 'ws') {
              const messageObj = {
                type: "text",
                data: {
                  text: message,
                  color: options.color || "white",
                  bold: !!options.bold,
                  italic: !!options.italic,
                  underlined: !!options.underline
                }
              };

              await LinkService.sendRequestAndWaitResponse('broadcast', {
                message: [messageObj]
              });

              return await LinkService.autoRecall(`[${session.serverConfig.name}] 消息已广播`, session);
            } else {
              throw new Error('跳过WebSocket尝试')
            }
          },
          async () => {
            // RCON回退方式 - 只能发送基本消息，不支持样式
            const command = `say ${message}`;
            return await LinkService.executeRconCommand(command, config, session);
          }
        )
        return String(result)
      } catch (error) {
        return `广播消息失败: ${error.message}`
      }
    });

  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-t <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .option('color', '-c <color:string> 标题颜色', { fallback: 'white' })
    .option('subcolor', '-C <color:string> 副标题颜色', { fallback: 'white' })
    .action(async ({ options, session }, title, subtitle = '') => {
      try {
        const result = await tryWithFallback(
          session,
          async () => {
            if (session.connectionType === 'ws') {
              const titleObj = {
                type: "text",
                data: {
                  text: title,
                  color: options.color || "white"
                }
              };

              const requestData: any = {
                title: [titleObj],
                fadein: options.fadein * 20,
                stay: options.stay * 20,
                fadeout: options.fadeout * 20
              };

              if (subtitle) {
                const subtitleObj = {
                  type: "text",
                  data: {
                    text: subtitle,
                    color: options.subcolor || "white"
                  }
                };
                requestData.subtitle = [subtitleObj];
              }

              await LinkService.sendRequestAndWaitResponse('send_title', requestData);
              return await LinkService.autoRecall(`[${session.serverConfig.name}] 标题已发送`, session);
            } else {
              throw new Error('跳过WebSocket尝试')
            }
          },
          async () => {
            // RCON回退方式
            let cmd = `title @a title {"text":"${title}"}`
            await LinkService.executeRconCommand(cmd, config, session)
            if (subtitle) {
              cmd = `title @a subtitle {"text":"${subtitle}"}`
              await LinkService.executeRconCommand(cmd, config, session)
            }
            cmd = `title @a times ${options.fadein * 20} ${options.stay * 20} ${options.fadeout * 20}`
            return await LinkService.executeRconCommand(cmd, config, session)
          }
        )
        return String(result)
      } catch (error) {
        return `标题发送失败: ${error.message}`
      }
    })

  mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
    .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
    .option('bold', '-b 粗体显示')
    .action(async ({ session, options }, message) => {
      try {
        const result = await tryWithFallback(
          session,
          async () => {
            if (session.connectionType === 'ws') {
              const messageObj = {
                type: "text",
                data: {
                  text: message,
                  color: options.color || "white",
                  bold: !!options.bold
                }
              };

              await LinkService.sendRequestAndWaitResponse('send_actionbar', {
                message: [messageObj]
              });

              return await LinkService.autoRecall(`[${session.serverConfig.name}] 动作栏消息已发送`, session);
            } else {
              throw new Error('跳过WebSocket尝试')
            }
          },
          async () => {
            // RCON回退方式
            const cmd = `title @a actionbar {"text":"${message}"}`
            return await LinkService.executeRconCommand(cmd, config, session)
          }
        )
        return String(result)
      } catch (error) {
        return `动作栏消息发送失败: ${error.message}`
      }
    })

  mcserver.subcommand('.player', '获取服务器在线玩家信息')
    .action(async ({ session }) => {
      try {
        const result = await tryWithFallback(
          session,
          async () => {
            if (session.connectionType === 'ws') {
              const response = await LinkService.sendRequestAndWaitResponse('get_players', {})
              if (!response.data || !response.data.players) {
                throw new Error('无法获取玩家信息')
              }
              const { players, server_name = session.serverConfig.name, server_type, max_players = '?' } = response.data
              let message = `[${server_name}] 在线玩家(${players.length}/${max_players}):\n`
              message += players.map((player: any) => {
                const name = player.nickname || player.display_name || player.name
                const details = LinkService.getPlayerDetails(player, server_type as LinkService.ServerType)
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
            } else {
              throw new Error('跳过WebSocket尝试')
            }
          },
          async () => {
            // RCON回退方式
            return await LinkService.executeRconCommand('list', config, session)
          }
        )
        return String(result)
      } catch (error) {
        return `获取玩家信息失败: ${error.message}`
      }
    })

  mcserver.subcommand('.run <command:text>', '执行自定义命令', { authority: 3 })
    .action(async ({ session }, command) => {
      if (!command) return LinkService.autoRecall('请输入要执行的命令', session)

      // RCON命令必须通过RCON执行
      const { serverConfig } = session
      if (!serverConfig.rcon?.password) {
        return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON，无法执行自定义命令`, session)
      }

      try {
        const result = await LinkService.executeRconCommand(command, config, session)
        return String(result)
      } catch (error) {
        return `命令执行失败: ${error.message}`
      }
    })
}