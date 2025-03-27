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
   * @param serverConfig 服务器配置
   * @returns 连接状态字符串
   */
  async function testRconConnection(serverConfig) {
    if (!serverConfig.rcon.password) return 'x'
    try {
      const [host, portStr] = serverConfig.rcon.address.split(':')
      const port = parseInt(portStr)
      const rcon = await Rcon.connect({
        host, port, password: serverConfig.rcon.password,
        timeout: 3000 // 设置较短的超时时间避免长时间等待
      })
      await rcon.end()
      return '√'
    } catch (error) {
      return '连接失败'
    }
  }

  /**
   * 自动检查服务器权限和连接方式
   * 1. 检查是否指定服务器或在关联群组中
   * 2. 检查服务器配置是否有效
   * 3. 检查连接方式(WebSocket或RCON)
   */
  const checkServerAndConnection = async ({ session, options }) => {
    // 1. 确定要操作的服务器
    let serverConfig = null

    if (options.server) {
      // 优先使用-s选项指定的服务器
      serverConfig = config.link.servers.find(s => s.name === options.server)
      if (!serverConfig) {
        return { pass: false, message: `找不到服务器: ${options.server}` }
      }
    } else if (session?.channelId) {
      // 其次使用群组绑定的服务器
      const channelKey = `${session.platform}:${session.channelId}`
      serverConfig = config.link.servers.find(server => server.group === channelKey)
      if (!serverConfig) {
        return { pass: false, message: `当前会话未关联任何Minecraft服务器` }
      }
    } else {
      return { pass: false, message: `无法确定目标服务器` }
    }

    // 2. 保存服务器配置到会话中
    session.serverConfig = serverConfig

    // 3. 确定连接方式 - 优先WebSocket，如不可用则尝试RCON
    let connectionTypes = []

    if (serverConfig.websocket && serverConfig.websocket.token) {
      // 检查WebSocket连接状态
      const serverConn = LinkService.serverConnections.get(serverConfig.name)
      const isConnected = serverConn && (
        (serverConn.ws && serverConn.ws.readyState === 1) ||
        serverConn.clients.size > 0
      )

      if (isConnected) {
        connectionTypes.push('ws')
      }
    }

    if (serverConfig.rcon && serverConfig.rcon.password) {
      connectionTypes.push('rcon')
    }

    if (connectionTypes.length === 0) {
      return {
        pass: false,
        message: `服务器 ${serverConfig.name} 未配置可用的连接方式或连接未建立`
      }
    }

    // 保存所有可用连接类型到会话，优先使用WebSocket
    session.connectionTypes = connectionTypes
    session.connectionType = connectionTypes[0]

    return { pass: true }
  }

  /**
   * 在WebSocket失败时尝试回退到RCON
   * @param session 当前会话
   * @param operation WebSocket操作失败时的回调
   * @param fallback RCON回退操作的回调
   */
  async function tryWithFallback(session, operation, fallback) {
    const { serverConfig, connectionTypes } = session

    // 首先尝试主要连接方式
    try {
      return await operation()
    } catch (error) {
      ctx.logger.warn(`[${serverConfig.name}] 主要连接方式失败: ${error.message}, 尝试回退方式`)

      // 尝试回退到RCON (如果可用且不是当前连接方式)
      if (connectionTypes.includes('rcon') && session.connectionType !== 'rcon') {
        session.connectionType = 'rcon'
        try {
          return await fallback()
        } catch (fallbackError) {
          throw new Error(`所有连接方式都失败: ${error.message}, 回退方式: ${fallbackError.message}`)
        }
      }

      // 如果没有回退方式或回退方式也失败
      throw error
    }
  }

  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(checkServerAndConnection)
    .action(async ({ session, options }) => {
      // 如果是通过 .server 命令查询状态，跳过连接检查
      if (!session.serverConfig) {
        // 获取基础状态信息
        const statusMessage = ['Minecraft 服务器状态:']

        // 获取当前群组关联的服务器或指定的服务器
        const currentServer = (() => {
          if (options.server) {
            return config.link.servers.find(s => s.name === options.server) || null
          }
          if (!session?.channelId) return null
          const channelKey = `${session.platform}:${session.channelId}`
          return config.link.servers.find(server => server.group === channelKey) || null
        })()

        // 测试所有服务器的RCON连接状态并收集结果
        const rconStatusPromises = config.link.servers.map(async server => {
          return {
            serverName: server.name,
            rconStatus: await testRconConnection(server)
          }
        })

        const rconStatusResults = await Promise.all(rconStatusPromises)
        const rconStatusMap = rconStatusResults.reduce((map, { serverName, rconStatus }) => {
          map[serverName] = rconStatus
          return map
        }, {})

        // 显示所有服务器连接状态
        config.link.servers.forEach(server => {
          const serverConn = LinkService.serverConnections.get(server.name)
          const rconStatus = rconStatusMap[server.name]
          let wsStatus = 'x'
          if (server.websocket.token) {
            const isConnected = serverConn && (
              (serverConn.ws && serverConn.ws.readyState === 1) ||
              serverConn.clients.size > 0
            )
            wsStatus = isConnected ? server.websocket.mode : 'Connecting'
          }
          // 显示当前群组的服务器标识
          const isCurrentGroup = currentServer && currentServer.name === server.name ? '[√]' : ''
          statusMessage.push(`${server.name}${isCurrentGroup} RCON:${rconStatus} WebSocket:${wsStatus}`)
        })

        // 尝试重连未连接的WebSocket
        config.link.servers.forEach(server => {
          if (!server.websocket.token) return
          const serverConn = LinkService.serverConnections.get(server.name)
          const isConnected = serverConn && (
            (serverConn.ws && serverConn.ws.readyState === 1) ||
            serverConn.clients.size > 0
          )
          if (!serverConn || !isConnected) {
            statusMessage.push(`\n正在重新连接服务器 [${server.name}]...`)
            LinkService.cleanupWebSocket(server.name)

            if (server.websocket.mode === 'client') {
              LinkService.initWebSocketClient(ctx, config, server)
            } else {
              LinkService.initWebSocketServer(ctx, config, server)
            }
          }
        })

        // 如果有当前服务器，则获取其详细状态
        if (currentServer) {
          statusMessage.push('') // 空行
          session.serverConfig = currentServer // 临时设置用于获取详细信息

          // 获取具体的服务器状态
          if (currentServer.websocket.token) {
            try {
              const response = await LinkService.sendRequestAndWaitResponse('get_server_status', {}, currentServer.name)

              if (response.data) {
                const {
                  server_name = currentServer.name,
                  version,
                  online_players = 0,
                  max_players = '?',
                  tps,
                  memory_used,
                  memory_total,
                  uptime
                } = response.data;

                statusMessage.push(`[${server_name}] 详细信息:`);

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
                  const playerResponse = await LinkService.sendRequestAndWaitResponse('get_players', {}, currentServer.name)
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
              if (currentServer.rcon.password) {
                await fallbackToRcon();
              }
            }
          } else if (currentServer.rcon.password) {
            await fallbackToRcon();
          }

          async function fallbackToRcon() {
            try {
              const [host, portStr] = currentServer.rcon.address.split(':')
              const port = parseInt(portStr)
              const rcon = await Rcon.connect({
                host, port, password: currentServer.rcon.password
              })
              const listResult = await rcon.send('list')
              await rcon.end()
              statusMessage.push(`[${currentServer.name}] RCON状态:\n${listResult}`)
            } catch (rconError) {
              statusMessage.push(`[${currentServer.name}] RCON连接失败: ${rconError.message}`)
            }
          }
        }

        return statusMessage.join('\n')
      } else {
        return '使用子命令操作服务器，例如: .server say 你好'
      }
    })

  // 定义消息发送相关命令
  mcserver.subcommand('.say <message:text>', '发送消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .action(async ({ session }, message) => {
      return await tryWithFallback(
        session,
        async () => {
          if (session.connectionType === 'ws') {
            const userIdentifier = session.username || session.userId
            const formattedMsg = `${userIdentifier}: ${message}`
            return await LinkService.sendMinecraftMessage('text', {
              message: formattedMsg
            }, session.serverConfig.name, `[${session.serverConfig.name}] 消息已发送`)
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
            session,
            session.serverConfig.name
          )
        }
      ).catch(error => {
        return `消息发送失败: ${error.message}`
      })
    })

  mcserver.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .action(async ({ session }, player, message) => {
      return await tryWithFallback(
        session,
        async () => {
          if (session.connectionType === 'ws') {
            const userIdentifier = session.username || session.userId
            const formattedMsg = `${userIdentifier}: ${message}`
            return await LinkService.sendMinecraftMessage('private', {
              player,
              message: formattedMsg
            }, session.serverConfig.name, `[${session.serverConfig.name}] 私聊消息已发送给 ${player}`)
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
            session,
            session.serverConfig.name
          )
        }
      ).catch(error => {
        return `私聊消息发送失败: ${error.message}`
      })
    })

  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
    .option('bold', '-b 粗体显示')
    .option('italic', '-i 斜体显示')
    .option('underline', '-u 下划线显示')
    .action(async ({ session, options }, message) => {
      return await tryWithFallback(
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
            }, session.serverConfig.name);

            return await LinkService.autoRecall(`[${session.serverConfig.name}] 消息已广播`, session);
          } else {
            throw new Error('跳过WebSocket尝试')
          }
        },
        async () => {
          // RCON回退方式 - 只能发送基本消息，不支持样式
          const command = `say ${message}`;
          return await LinkService.executeRconCommand(command, config, session, session.serverConfig.name);
        }
      ).catch(error => {
        return `广播消息失败: ${error.message}`
      })
    });

  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-t <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .option('color', '-c <color:string> 标题颜色', { fallback: 'white' })
    .option('subcolor', '-C <color:string> 副标题颜色', { fallback: 'white' })
    .action(async ({ options, session }, title, subtitle = '') => {
      return await tryWithFallback(
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

            await LinkService.sendRequestAndWaitResponse('send_title', requestData, session.serverConfig.name);
            return await LinkService.autoRecall(`[${session.serverConfig.name}] 标题已发送`, session);
          } else {
            throw new Error('跳过WebSocket尝试')
          }
        },
        async () => {
          // RCON回退方式
          let cmd = `title @a title {"text":"${title}"}`
          await LinkService.executeRconCommand(cmd, config, session, session.serverConfig.name)
          if (subtitle) {
            cmd = `title @a subtitle {"text":"${subtitle}"}`
            await LinkService.executeRconCommand(cmd, config, session, session.serverConfig.name)
          }
          cmd = `title @a times ${options.fadein * 20} ${options.stay * 20} ${options.fadeout * 20}`
          return await LinkService.executeRconCommand(cmd, config, session, session.serverConfig.name)
        }
      ).catch(error => {
        return `标题发送失败: ${error.message}`
      })
    })

  mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
    .option('bold', '-b 粗体显示')
    .action(async ({ session, options }, message) => {
      return await tryWithFallback(
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
            }, session.serverConfig.name);

            return await LinkService.autoRecall(`[${session.serverConfig.name}] 动作栏消息已发送`, session);
          } else {
            throw new Error('跳过WebSocket尝试')
          }
        },
        async () => {
          // RCON回退方式
          const cmd = `title @a actionbar {"text":"${message}"}`
          return await LinkService.executeRconCommand(cmd, config, session, session.serverConfig.name)
        }
      ).catch(error => {
        return `动作栏消息发送失败: ${error.message}`
      })
    })

  mcserver.subcommand('.player', '获取服务器在线玩家信息')
    .option('server', '-s <name:string> 指定服务器名称')
    .action(async ({ session }) => {
      return await tryWithFallback(
        session,
        async () => {
          if (session.connectionType === 'ws') {
            const response = await LinkService.sendRequestAndWaitResponse('get_players', {}, session.serverConfig.name)
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
          return await LinkService.executeRconCommand('list', config, session, session.serverConfig.name)
        }
      ).catch(error => {
        return `获取玩家信息失败: ${error.message}`
      })
    })

  mcserver.subcommand('.run <command:text>', '执行自定义命令', { authority: 3 })
    .option('server', '-s <name:string> 指定服务器名称')
    .action(async ({ session }, command) => {
      if (!command) return LinkService.autoRecall('请输入要执行的命令', session)

      // RCON命令必须通过RCON执行
      const { serverConfig } = session
      if (!serverConfig.rcon?.password) {
        return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON，无法执行自定义命令`, session)
      }

      try {
        return await LinkService.executeRconCommand(command, config, session, serverConfig.name)
      } catch (error) {
        return `命令执行失败: ${error.message}`
      }
    })
}