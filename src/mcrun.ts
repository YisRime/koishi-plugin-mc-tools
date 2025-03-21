import { Context, Session } from 'koishi'
import { Rcon } from 'rcon-client'
import { MinecraftToolsConfig } from './index'

/**
 * 自动撤回消息
 */
async function autoRecall(message: string, session?: Session): Promise<void> {
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
  if (!command) return autoRecall('请输入要执行的命令', session)
  if (!config.info.rconPassword) return autoRecall('请先配置RCON密码', session)

  const [serverHost, portStr] = (config.info.defaultRcon || '').split(':')
  const port = portStr ? parseInt(portStr) : 25575

  if (!serverHost) return autoRecall('请先配置RCON地址', session)
  if (isNaN(port)) return autoRecall('RCON端口不正确', session)

  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.info.rconPassword
    })

    const result = await rcon.send(command)
    await rcon.end()

    return autoRecall(`命令执行成功${result}`, session)
  } catch (error) {
    const errorMsg = `RCON连接失败: ${error.message}`
    return autoRecall(errorMsg, session)
  }
}

/**
 * 注册命令
 */
export function registerRunCommands(ctx: Context, parent: any, config: MinecraftToolsConfig) {
  // 主命令
  const mcrun = parent.subcommand('.run <message:text>', '执行 Minecraft 命令')
    .usage('mc.run <消息> - 发送消息到 Minecraft 服务器')
    .before(({ session }) => {
      // 检查群组权限
      if (config.info.authorizedGroups?.length > 0 &&
          !(session?.guildId && config.info.authorizedGroups.includes(session.guildId))) {
        return autoRecall('此群组没有权限执行命令', session)
      }
    })
    .action(async ({ session }, message) => {
      if (!message) return autoRecall('请输入要发送的消息', session)
      // 获取用户昵称或ID
      const userIdentifier = session.username || session.userId
      return executeRconCommand(`say ${userIdentifier}: ${message}`, config, session)
    })

  // 白名单管理
  mcrun.subcommand('.wl [player:string]', '管理白名单', { authority: 2 })
    .option('r', '-r 移除玩家')
    .option('on', '--on 开启白名单')
    .option('off', '--off 关闭白名单')
    .usage('mc.run.wl - 查看白名单\nmc.run.wl <玩家名> - 添加玩家到白名单\nmc.run.wl -r <玩家名> - 从白名单移除玩家\nmc.run.wl --on/off - 开启/关闭白名单')
    .action(({ options, session }, player) => {
      let cmd;

      if (options.off) cmd = 'whitelist off'
      else if (options.on) cmd = 'whitelist on'
      else if (options.r) {
        if (!player) return autoRecall('请输入玩家名', session)
        cmd = `whitelist remove ${player}`
      }
      else if (player) cmd = `whitelist add ${player}`
      else cmd = 'whitelist list'

      return executeRconCommand(cmd, config, session)
    })

  // OP管理
  mcrun.subcommand('.op <player:string>', '管理管理员', { authority: 3 })
    .option('r', '-r 移除权限')
    .usage('mc.run.op <玩家名> - 添加管理员权限\nmc.run.op -r <玩家名> - 移除管理员权限')
    .action(({ options, session }, player) =>
      player ? executeRconCommand(options.r ? `deop ${player}` : `op ${player}`, config, session) :
               autoRecall('请输入玩家名', session))

  // 踢出玩家
  mcrun.subcommand('.kick <player:string> [reason:text]', '踢出玩家', { authority: 2 })
    .usage('mc.run.kick <玩家名> [理由] - 将玩家踢出服务器')
    .action(({ session }, player, reason) =>
      player ? executeRconCommand(`kick ${player}${reason ? ` ${reason}` : ''}`, config, session) :
               autoRecall('请输入玩家名', session))

  // 封禁玩家
  mcrun.subcommand('.ban <player:string> [reason:text]', '封禁玩家', { authority: 3 })
    .option('ip', '--ip 封禁IP')
    .usage('mc.run.ban <玩家名> [理由] - 封禁玩家\nmc.run.ban --ip <IP地址> [理由] - 封禁IP地址')
    .action(({ options, session }, player, reason) => {
      if (!player) return autoRecall('请输入玩家名或IP地址', session)
      const cmd = `${options.ip ? 'ban-ip' : 'ban'} ${player}${reason ? ` ${reason}` : ''}`
      return executeRconCommand(cmd, config, session)
    })

  // 自定义命令
  mcrun.subcommand('.cmd [...args]', '执行自定义命令')
    .usage('mc.run.cmd <命令> - 执行自定义 Minecraft 命令')
    .action(({ session }, ...args) => {
      // 用户权限检查
      if (!config.info.authorizedRunUsers.includes(session?.userId))
        return autoRecall('你没有权限执行自定义命令', session)
      return args.length ? executeRconCommand(args.join(' '), config, session) :
                           autoRecall('请输入要执行的命令', session)
    })
}
