import { Context } from 'koishi'
import { MinecraftToolsConfig } from './index'
import * as LinkService from './linkservice'
import { Rcon } from 'rcon-client'

// 导出公共函数和枚举
export { McEvent } from './linkservice'
export const extractAndRemoveColor = LinkService.extractAndRemoveColor
export const cleanupWebSocket = LinkService.cleanupWebSocket
export const executeRconCommand = LinkService.executeRconCommand
export const sendWebSocketMessage = LinkService.sendWebSocketMessage

// 命令注册
export function registerServerCommands(parent: any, config: MinecraftToolsConfig, ctx: Context) {
  // 主命令
  const mcserver = parent.subcommand('.server', '管理 Minecraft 服务器')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .action(async ({ session }) => {
      const statusMessage = ['Minecraft 服务器状态:']

      if (config.link.servers.length === 0) {
        return LinkService.autoRecall('未配置任何服务器', session)
      }

      statusMessage.push(`默认服务器: ${config.link.defaultServer || '未设置'}`)
      statusMessage.push('\n可用服务器列表:')

      config.link.servers.forEach(server => {
        const serverConn = LinkService.serverConnections.get(server.id)
        const rconStatus = server.rcon.enabled ? '已启用' : '未启用'
        const wsStatus = server.websocket.enabled ?
          (serverConn && LinkService.isConnected(serverConn) ? '已连接' : '未连接') : '未启用'

        statusMessage.push(`- ${server.name} (${server.id})`)
        statusMessage.push(`  RCON: ${rconStatus} (${server.rcon.address})`)
        statusMessage.push(`  WebSocket: ${wsStatus} (${server.websocket.mode}模式, ${server.websocket.address})`)
      })

      if (config.link.groups.length > 0) {
        statusMessage.push(`\n消息转发群组: ${config.link.groups.join(', ')}`)
      }

      // 尝试重连未连接的WebSocket
      config.link.servers.forEach(server => {
        if (!server.websocket.enabled || !server.websocket.token) return

        const serverConn = LinkService.serverConnections.get(server.id)
        if (!serverConn || !LinkService.isConnected(serverConn)) {
          statusMessage.push(`\n正在自动重新连接 ${server.name} 的WebSocket...`)
          LinkService.cleanupWebSocket(server.id)

          if (server.websocket.mode === 'client') {
            LinkService.initWebSocketClient(ctx, config, server)
          } else {
            LinkService.initWebSocketServer(ctx, config, server)
          }
        }
      })

      return LinkService.autoRecall(statusMessage.join('\n'), session)
    })

  // 检查群组权限
  const checkGroupPermission = ({ session }) => {
    if (!LinkService.isChannelInList(session, config.link.groups)) {
      return LinkService.autoRecall('此群组没有权限执行服务器命令', session)
    }
  }

  // 检查服务器存在
  const getTargetServerId = (options): string => {
    if (options.server) {
      const exists = config.link.servers.some(s => s.id === options.server)
      if (!exists) {
        throw new Error(`服务器 ${options.server} 不存在`)
      }
      return options.server
    }
    return config.link.defaultServer
  }

  // 消息发送命令
  mcserver.subcommand('.say <message:text>', '发送消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, message) => {
      if (!message) return LinkService.autoRecall('请输入要发送的消息', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await LinkService.sendMinecraftMessage('text', { message }, serverId)
          return LinkService.autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          const userIdentifier = session.username || session.userId
          return LinkService.executeRconCommand(`say ${userIdentifier}: ${message}`, config, session, serverId)
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  mcserver.subcommand('.tell <player:string> <message:text>', '向指定玩家发送私聊消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, player, message) => {
      if (!player || !message) return LinkService.autoRecall('用法: mc.server.tell <玩家名> <消息>', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await LinkService.sendMinecraftMessage('private', { player, message }, serverId, `向玩家 ${player} 发送消息成功`)
          return LinkService.autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          const userIdentifier = session.username || session.userId
          return LinkService.executeRconCommand(`tell ${player} ${userIdentifier}: ${message}`, config, session, serverId)
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 标题和动作栏命令
  mcserver.subcommand('.title <title:string> [subtitle:string]', '发送标题消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('fadein', '-i <seconds:number> 淡入时间(秒)', { fallback: 1 })
    .option('stay', '-s <seconds:number> 停留时间(秒)', { fallback: 3 })
    .option('fadeout', '-o <seconds:number> 淡出时间(秒)', { fallback: 1 })
    .before(checkGroupPermission)
    .action(async ({ options, session }, title, subtitle = '') => {
      if (!title) return LinkService.autoRecall('请输入要发送的标题', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await LinkService.sendMinecraftMessage('title', {
            title,
            subtitle,
            fadein: options.fadein * 20,
            stay: options.stay * 20,
            fadeout: options.fadeout * 20
          }, serverId)
          return LinkService.autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          // 使用RCON执行
          let cmd = `title @a title {"text":"${title}"}`
          await LinkService.executeRconCommand(cmd, config, session, serverId)

          if (subtitle) {
            cmd = `title @a subtitle {"text":"${subtitle}"}`
            await LinkService.executeRconCommand(cmd, config, session, serverId)
          }

          cmd = `title @a times ${options.fadein * 20} ${options.stay * 20} ${options.fadeout * 20}`
          return LinkService.executeRconCommand(cmd, config, session, serverId)
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, message) => {
      if (!message) return LinkService.autoRecall('请输入要发送的消息', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await LinkService.sendMinecraftMessage('actionbar', { message }, serverId)
          return LinkService.autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          const cmd = `title @a actionbar {"text":"${message}"}`
          return LinkService.executeRconCommand(cmd, config, session, serverId)
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 玩家信息查询命令
  mcserver.subcommand('.player', '获取服务器在线玩家信息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }) => {
      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          try {
            await session.send(`正在获取 ${serverConfig.name} 的玩家信息...`)
            const response = await LinkService.sendRequestAndWaitResponse('get_players', {}, serverId)

            if (!response.data || !response.data.players) {
              return LinkService.autoRecall('没有获取到玩家信息或服务器返回数据格式错误。', session)
            }

            const { players, server_name = serverConfig.name, server_type = 'unknown', max_players = '?' } = response.data

            if (players.length === 0) {
              return LinkService.autoRecall(`[${server_name}] 当前没有在线玩家`, session)
            }

            let message = `[${server_name}] 在线玩家(${players.length}/${max_players}):\n`

            message += players.map((player: any) => {
              const name = LinkService.getPlayerName(player)
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
            // WebSocket请求失败，尝试RCON
            if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
              return LinkService.executeRconCommand('list', config, session, serverId)
            }
            return LinkService.autoRecall(`获取信息失败: ${error.message}`, session)
          }
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          return LinkService.executeRconCommand('list', config, session, serverId)
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 广播消息命令
  mcserver.subcommand('.broadcast <message:text>', '广播消息')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, message) => {
      if (!message) return LinkService.autoRecall('请输入要广播的消息', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          const result = await LinkService.sendMinecraftMessage('text', { message }, serverId)
          return LinkService.autoRecall(`[${serverConfig.name}] ${result}`, session)
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          return LinkService.executeRconCommand(`say ${message}`, config, session, serverId)
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 服务器状态
  mcserver.subcommand('.status', '查看服务器状态')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }) => {
      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (serverConfig.websocket.enabled && serverConfig.websocket.token) {
          try {
            const response = await LinkService.sendRequestAndWaitResponse('get_server_status', {}, serverId)

            if (!response.data) {
              if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
                return LinkService.executeRconCommand('list', config, session, serverId)
              }
              return LinkService.autoRecall('无法获取服务器状态信息', session)
            }

            const {
              server_name = serverConfig.name,
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

            return LinkService.autoRecall(statusLines.join('\n'), session)
          } catch (error) {
            if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
              return LinkService.executeRconCommand('list', config, session, serverId)
            }
            return LinkService.autoRecall(`获取服务器状态失败: ${error.message}`, session)
          }
        } else if (serverConfig.rcon.enabled && serverConfig.rcon.password) {
          try {
            const listPromise = new Promise<string>(async (resolve) => {
              const [host, portStr] = serverConfig.rcon.address.split(':')
              const port = parseInt(portStr) || 25575

              const rcon = await Rcon.connect({
                host,
                port,
                password: serverConfig.rcon.password
              })

              const listResult = await rcon.send('list')
              await rcon.end()
              resolve(listResult)
            })

            const result = await listPromise
            return LinkService.autoRecall(`[${serverConfig.name}] 状态:\n${result}`, session)
          } catch (error) {
            return LinkService.autoRecall(`RCON连接失败: ${error.message}`, session)
          }
        } else {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置可用的连接方式`, session)
        }
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 服务器管理命令（仅RCON支持）
  mcserver.subcommand('.admin', '服务器管理命令')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(({ session }) => {
      return LinkService.autoRecall('管理命令用法:\n' +
        '.kick <玩家> [原因] - 踢出玩家\n' +
        '.ban <玩家> [原因] - 封禁玩家\n' +
        '.op <玩家> - 给予管理员权限\n' +
        '.wl [玩家] - 管理白名单\n' +
        '.run <命令> - 执行自定义命令', session)
    })

  // 踢出玩家
  mcserver.subcommand('.kick <player:string> [reason:text]', '踢出玩家', { authority: 2 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, player, reason) => {
      if (!player) return LinkService.autoRecall('请输入玩家名', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        const cmd = `kick ${player}${reason ? ` ${reason}` : ''}`
        return LinkService.executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 封禁玩家
  mcserver.subcommand('.ban <player:string> [reason:text]', '封禁玩家', { authority: 3 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('ip', '--ip 封禁IP')
    .before(checkGroupPermission)
    .action(async ({ options, session }, player, reason) => {
      if (!player) return LinkService.autoRecall('请输入玩家名或IP地址', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        const cmd = `${options.ip ? 'ban-ip' : 'ban'} ${player}${reason ? ` ${reason}` : ''}`
        return LinkService.executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 管理管理员
  mcserver.subcommand('.op <player:string>', '管理管理员', { authority: 3 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('r', '-r 移除权限')
    .before(checkGroupPermission)
    .action(async ({ options, session }, player) => {
      if (!player) return LinkService.autoRecall('请输入玩家名', session)

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        const cmd = `${options.r ? 'deop' : 'op'} ${player}`
        return LinkService.executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 管理白名单
  mcserver.subcommand('.wl [player:string]', '管理白名单', { authority: 2 })
    .option('server', '-s <serverId:string> 指定服务器ID')
    .option('r', '-r 移除玩家')
    .option('on', '--on 开启白名单')
    .option('off', '--off 关闭白名单')
    .before(checkGroupPermission)
    .action(async ({ options, session }, player) => {
      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
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

        return LinkService.executeRconCommand(cmd, config, session, serverId)
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })

  // 执行自定义命令
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .option('server', '-s <serverId:string> 指定服务器ID')
    .before(checkGroupPermission)
    .action(async ({ session, options }, command) => {
      if (!command) return LinkService.autoRecall('请输入要执行的命令', session)

      if (!config.link.sudoUsers.includes(session?.userId)) {
        return LinkService.autoRecall('你没有权限执行自定义命令', session)
      }

      try {
        const serverId = getTargetServerId(options)
        const serverConfig = LinkService.getServerConfig(config, serverId)

        if (!serverConfig) {
          return LinkService.autoRecall(`找不到服务器配置: ${serverId}`, session)
        }

        if (!serverConfig.rcon.enabled || !serverConfig.rcon.password) {
          return LinkService.autoRecall(`服务器 ${serverConfig.name} 未配置RCON`, session)
        }

        return LinkService.executeRconCommand(command, config, session, serverId)
      } catch (error) {
        return LinkService.autoRecall(`命令执行出错: ${error.message}`, session)
      }
    })
}

// 使用新的服务函数
export function initWebSocketCommunication(ctx: Context, config: MinecraftToolsConfig): void {
  LinkService.initWebSocketCommunication(ctx, config)
}
