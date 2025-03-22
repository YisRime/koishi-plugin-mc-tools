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
  // 主命令
  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .action(async ({ session }) => {
      // 获取状态信息
      const statusMessage = ['Minecraft 服务器状态:']

      const currentServer = (() => {
        if (!session?.channelId) return null
        const channelKey = `${session.platform}:${session.channelId}`
        return config.link.servers.find(server => server.group === channelKey)
      })()
      // 显示所有服务器状态
      config.link.servers.forEach(server => {
        const serverConn = LinkService.serverConnections.get(server.name)
        // RCON状态标识
        const rconStatus = server.rcon.password ? '√' : 'x'
        // WebSocket状态
        let wsStatus = 'x'
        if (server.websocket.token) {
          const isConnected = serverConn && (
            (serverConn.ws && serverConn.ws.readyState === 1) ||
            serverConn.clients.size > 0
          )
          wsStatus = isConnected ? server.websocket.mode : 'Connecting'
        }
        // 是否为当前群组的服务器
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
      return LinkService.autoRecall(statusMessage.join('\n'), session)
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

  mcserver.subcommand('.say <message:text>', '发送消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          return LinkService.executeRconCommand(`say ${message}`, config, session, serverConfig.name)
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
          return LinkService.executeRconCommand(`tell ${player} ${message}`, config, session, serverConfig.name)
        } else {
          const userIdentifier = session.username || session.userId
          return LinkService.executeRconCommand(`tell ${player} ${userIdentifier}: ${message}`, config, session, serverConfig.name)
        }
      })
    })
  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-s <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .before(autoCheckServerPermission)
    .action(async ({ options, session }, title, subtitle = '') => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          return LinkService.executeRconCommand(`title @a title {"text":"${title}"}`, config, session, serverConfig.name)
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
    .before(autoCheckServerPermission)
    .action(async ({ session }, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          return LinkService.executeRconCommand(`title @a actionbar {"text":"${message}"}`, config, session, serverConfig.name)
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
            return LinkService.autoRecall(message, session)
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
  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }, message) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig;
        if (type === 'ws') {
          return LinkService.autoRecall(`[${serverConfig.name}] 消息已广播`, session);
        }
        if (!serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session);
        }
        const command = `say ${message}`;
        return LinkService.executeRconCommand(command, config, session, serverConfig.name);
      });
    });
  mcserver.subcommand('.kick <player:string> [reason:text]', '踢出玩家', { authority: 2 })
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }, player, reason) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig;
        if (type === 'rcon') {
          const command = `kick ${player}${reason ? ` ${reason}` : ''}`;
          return LinkService.executeRconCommand(command, config, session, serverConfig.name);
        }
        if (!serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session);
        }
        const command = `kick ${player}${reason ? ` ${reason}` : ''}`;
        return LinkService.executeRconCommand(command, config, session, serverConfig.name);
      });
    });
  mcserver.subcommand('.op <player:string>', '管理管理员', { authority: 3 })
    .option('server', '-s <name:string> 指定服务器名称')
    .option('r', '-r 移除权限')
    .before(autoCheckServerPermission)
    .action(async ({ session, options }, player) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig;
        if (type === 'rcon') {
          const command = `${options.r ? 'deop' : 'op'} ${player}`;
          return LinkService.executeRconCommand(command, config, session, serverConfig.name);
        }
        if (!serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session);
        }
        const command = `${options.r ? 'deop' : 'op'} ${player}`;
        return LinkService.executeRconCommand(command, config, session, serverConfig.name);
      });
    });
  mcserver.subcommand('.status', '查看服务器状态')
    .option('server', '-s <name:string> 指定服务器名称')
    .before(autoCheckServerPermission)
    .action(async ({ session }) => {
      return executeWithConnection(session, async (type) => {
        const serverConfig = session.serverConfig
        if (type === 'ws') {
          try {
            const response = await LinkService.sendRequestAndWaitResponse('get_server_status', {}, serverConfig.name)
            if (!response.data) {
              if (serverConfig.rcon.password) {
                return LinkService.executeRconCommand('list', config, session, serverConfig.name)
              }
              return LinkService.autoRecall('无法获取服务器状态信息', session)
            }
            const {
              server_name = serverConfig.name,
              version,
              online_players = 0,
              max_players = '?',
              tps,
              memory_used,
              memory_total,
              uptime
            } = response.data;
            const statusLines = [`[${server_name}] 状态信息:`];
            // 构建版本、玩家数和TPS信息行
            const infoItems = [];
            if (version) infoItems.push(version);
            infoItems.push(`${online_players}/${max_players}`);
            if (tps) infoItems.push(tps);
            if (infoItems.length > 0) {
              statusLines.push(infoItems.join(' | '));
            }
            // 内存信息
            if (memory_used || memory_total) {
              const memParts = [];
              if (memory_used) memParts.push(`${(memory_used / 1024 / 1024).toFixed(2)}MB`);
              if (memory_total) memParts.push(`${(memory_total / 1024 / 1024).toFixed(2)}MB`);
              statusLines.push(`RAM: ${memParts.join('/')}`);
            }
            // 运行时长
            if (uptime) {
              const hours = Math.floor(uptime / 3600);
              const minutes = Math.floor((uptime % 3600) / 60);
              statusLines.push(`运行时长: ${hours}时${minutes}分`);
            }
            return LinkService.autoRecall(statusLines.join('\n'), session);
          } catch (error) {
            if (serverConfig.rcon.password) {
              return LinkService.executeRconCommand('list', config, session, serverConfig.name)
            }
            return LinkService.autoRecall(`获取服务器状态失败: ${error.message}`, session)
          }
        } else {
          try {
            const [host, portStr] = serverConfig.rcon.address.split(':')
            const port = parseInt(portStr)
            const rcon = await Rcon.connect({
              host, port, password: serverConfig.rcon.password
            })
            const listResult = await rcon.send('list')
            await rcon.end()
            return LinkService.autoRecall(`[${serverConfig.name}] 状态:\n${listResult}`, session)
          } catch (error) {
            return LinkService.autoRecall(`RCON连接失败: ${error.message}`, session)
          }
        }
      })
    })
  mcserver.subcommand('.wl [player:string]', '管理白名单', { authority: 2 })
    .option('server', '-s <name:string> 指定服务器名称')
    .option('r', '-r 移除玩家')
    .option('on', '--on 开启白名单')
    .option('off', '--off 关闭白名单')
    .before(autoCheckServerPermission)
    .action(async ({ options, session }, player) => {
      const serverConfig = session.serverConfig;
      if (!serverConfig.rcon.password) {
        return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
      }
      let cmd;
      if (options.off) cmd = 'whitelist off'
      else if (options.on) cmd = 'whitelist on'
      else if (options.r) {
        if (!player) return LinkService.autoRecall('请输入玩家名', session)
        cmd = `whitelist remove ${player}`
      }
      else if (player) cmd = `whitelist add ${player}`
      else cmd = 'whitelist list'
      return LinkService.executeRconCommand(cmd, config, session, serverConfig.name)
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