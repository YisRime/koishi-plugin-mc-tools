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

  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .option('server', '-s <name:string> 指定服务器名称')
    .action(async ({ session, options }) => {
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

        try {
          // 为当前或指定服务器显示详细状态
          session.serverConfig = currentServer

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
        } catch (error) {
          statusMessage.push(`获取服务器状态失败: ${error.message}`)
        }
      }

      return statusMessage.join('\n')
    })

  /**
   * 自动检查服务器权限和获取服务器配置
   * 优先使用-s选项指定的服务器，其次使用群组绑定的服务器
   */
  const autoCheckServerPermission = ({ session, options }) => {
    if (options.server) {
      const serverConfig = config.link.servers.find(s => s.name === options.server)
      if (!serverConfig) {
        return LinkService.autoRecall(`找不到服务器: ${options.server}`, session)
      }
      session.serverConfig = serverConfig
      return
    }

    const serverConfig = (() => {
      if (!session?.channelId) return null
      const channelKey = `${session.platform}:${session.channelId}`
      return config.link.servers.find(server => server.group === channelKey)
    })()

    session.serverConfig = serverConfig
  }

  /**
   * 执行与连接相关的操作
   */
  const executeWithConnection = async (session, callback) => {
    try {
      const serverConfig = session.serverConfig
      if (serverConfig.websocket.token) {
        return await callback('ws')
      } else if (serverConfig.rcon.password) {
        return await callback('rcon')
      } else {
        return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
      }
    } catch (error) {
      return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
    }
  }

  // 定义消息发送相关命令
  mcserver.subcommand('.say <message:text>', '发送消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          try {
            const userIdentifier = session.username || session.userId
            const formattedMsg = `${userIdentifier}: ${message}`
            const result = await LinkService.sendMinecraftMessage('text', {
              message: formattedMsg
            }, serverConfig.name, `[${serverConfig.name}] 消息已发送`)
            return result
          } catch (error) {
            return LinkService.autoRecall(`消息发送失败: ${error.message}`, session)
          }
        } else {
          const userIdentifier = session.username || session.userId
          return LinkService.executeRconCommand(`say ${userIdentifier}: ${message}`, config, session, serverConfig.name)
        }
      })
    })

  mcserver.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }, player, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          try {
            const userIdentifier = session.username || session.userId
            const formattedMsg = `${userIdentifier}: ${message}`
            const result = await LinkService.sendMinecraftMessage('private', {
              player,
              message: formattedMsg
            }, serverConfig.name, `[${serverConfig.name}] 私聊消息已发送给 ${player}`)
            return result
          } catch (error) {
            return LinkService.autoRecall(`私聊消息发送失败: ${error.message}`, session)
          }
        } else {
          const userIdentifier = session.username || session.userId
          return LinkService.executeRconCommand(`tell ${player} ${userIdentifier}: ${message}`, config, session, serverConfig.name)
        }
      })
    })

  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
    .option('bold', '-b 粗体显示')
    .option('italic', '-i 斜体显示')
    .option('underline', '-u 下划线显示')
    .before(autoCheckServerPermission)
    .action(async ({ session, options }, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig;
        if (type === 'ws') {
          try {
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
            }, serverConfig.name);

            return LinkService.autoRecall(`[${serverConfig.name}] 消息已广播`, session);
          } catch (error) {
            return LinkService.autoRecall(`广播消息失败: ${error.message}`, session);
          }
        } else {
          if (!serverConfig.rcon.password) {
            return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session);
          }
          const command = `say ${message}`;
          return LinkService.executeRconCommand(command, config, session, serverConfig.name);
        }
      });
    });

  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-t <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .option('color', '-c <color:string> 标题颜色', { fallback: 'white' })
    .option('subcolor', '-C <color:string> 副标题颜色', { fallback: 'white' })
    .before(autoCheckServerPermission)
    .action(async ({ options, session }, title, subtitle = '') => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          try {
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

            await LinkService.sendRequestAndWaitResponse('send_title', requestData, serverConfig.name);
            return LinkService.autoRecall(`[${serverConfig.name}] 标题已发送`, session);
          } catch (error) {
            return LinkService.autoRecall(`标题发送失败: ${error.message}`, session);
          }
        } else {
          let cmd = `title @a title {"text":"${title}"}`
          await LinkService.executeRconCommand(cmd, config, session, serverConfig.name)
          if (subtitle) {
            cmd = `title @a subtitle {"text":"${subtitle}"}`
            await LinkService.executeRconCommand(cmd, config, session, serverConfig.name)
          }
          cmd = `title @a times ${options.fadein * 20} ${options.stay * 20} ${options.fadeout * 20}`
          return LinkService.executeRconCommand(cmd, config, session, serverConfig.name)
        }
      })
    })

  mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
    .option('bold', '-b 粗体显示')
    .before(autoCheckServerPermission)
    .action(async ({ session, options }, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          try {
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
            }, serverConfig.name);

            return LinkService.autoRecall(`[${serverConfig.name}] 动作栏消息已发送`, session);
          } catch (error) {
            return LinkService.autoRecall(`动作栏消息发送失败: ${error.message}`, session);
          }
        } else {
          const cmd = `title @a actionbar {"text":"${message}"}`
          return LinkService.executeRconCommand(cmd, config, session, serverConfig.name)
        }
      })
    })

  mcserver.subcommand('.player', '获取服务器在线玩家信息')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          try {
            const response = await LinkService.sendRequestAndWaitResponse('get_players', {}, serverConfig.name)
            if (!response.data || !response.data.players) {
              return LinkService.autoRecall('无法获取玩家信息', session)
            }
            const { players, server_name = serverConfig.name, server_type, max_players = '?' } = response.data
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
          } catch (error) {
            if (serverConfig.rcon.password) {
              return LinkService.executeRconCommand('list', config, session, serverConfig.name)
            }
            return LinkService.autoRecall(`获取信息失败: ${error.message}`, session)
          }
        } else {
          return LinkService.executeRconCommand('list', config, session, serverConfig.name)
        }
      })
    })

  mcserver.subcommand('.run <command:text>', '执行自定义命令', { authority: 3 })
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }, command) => {
      if (!command) return LinkService.autoRecall('请输入要执行的命令', session)

      const serverConfig = session.serverConfig
      if (!serverConfig.rcon.password) {
        return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
      }
      return LinkService.executeRconCommand(command, config, session, serverConfig.name)
    })
}