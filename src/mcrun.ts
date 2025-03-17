import { Context, Logger } from 'koishi'
import { Rcon } from 'rcon-client'
import { MinecraftToolsConfig } from './index'

const logger = new Logger('mcrun')

/**
 * 执行RCON命令
 * @param {string} command - 要执行的命令
 * @param {string} serverConfig - RCON服务器配置 (格式: host:port)
 * @param {string} password - RCON密码
 * @param {any} logger - 日志记录器
 * @returns {Promise<string>} 执行结果
 */
export async function executeRconCommand(
  command: string,
  serverConfig: string,
  password: string
): Promise<string> {
  if (!command) return '请输入要执行的命令'
  if (!password) return '请先配置RCON密码'

  try {
    // 从服务器配置中提取地址和端口
    const [serverHost, portStr] = serverConfig.split(':')
    const port = portStr ? parseInt(portStr) : 25575

    if (!serverHost) return '请先配置RCON服务器地址'
    if (isNaN(port)) return 'RCON端口格式不正确'

    const rcon = await Rcon.connect({
      host: serverHost,
      port,
      password
    })
    // 发送命令并等待结果
    const result = await rcon.send(command).catch(error => {
      logger.warn(`RCON命令执行失败: ${error.message}`)
      throw error
    })
    await rcon.end()
    return result
  } catch (error) {
    return `RCON连接失败: ${error.message}`
  }
}

/**
 * 注册 Minecraft 运行命令
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - Minecraft 工具配置
 */
export function registerRunCommands(ctx: Context, config: MinecraftToolsConfig) {
  const mcrun = ctx.command('mcrun <message:text>', '在Minecraft服务器执行命令')
    .usage('mcrun <消息> - 在服务器发送消息')
    .action(async ({ }, message) => {
      if (!message) return '请输入要发送的消息'
      return await executeRconCommand(
        `say ${message}`,
        config.info.defaultRcon,
        config.info.rconPassword
      )
    })

  mcrun.subcommand('wl [player:string]', '管理服务器白名单', { authority: 2 })
    .option('r', '-r  从白名单中移除玩家')
    .option('on', '--on  开启白名单功能')
    .option('off', '--off  关闭白名单功能')
    .usage('mcrun wl - 显示白名单列表')
    .usage('mcrun wl [玩家名] - 添加玩家到白名单')
    .usage('mcrun wl -r <玩家名> - 从白名单中移除玩家')
    .usage('mcrun wl --on/off - 开启/关闭服务器白名单')
    .action(async ({ options }, player) => {

      if (options.off) {
        return await executeRconCommand(
          'whitelist off',
          config.info.defaultRcon,
          config.info.rconPassword
        )
      }

      if (options.on) {
        return await executeRconCommand(
          'whitelist on',
          config.info.defaultRcon,
          config.info.rconPassword
        )
      }

      if (options.r) {
        if (!player) return '请输入玩家名'
        return await executeRconCommand(
          `whitelist remove ${player}`,
          config.info.defaultRcon,
          config.info.rconPassword
        )
      }

      if (player) {
        return await executeRconCommand(
          `whitelist add ${player}`,
          config.info.defaultRcon,
          config.info.rconPassword
        )
      } else {
        return await executeRconCommand(
          'whitelist list',
          config.info.defaultRcon,
          config.info.rconPassword
        )
      }
    })

  mcrun.subcommand('op <player:string>', '管理服务器管理员', { authority: 3 })
    .option('r', '-r  移除玩家管理员权限')
    .usage('mcrun op [-r] [玩家名] - 添加/移除服务器管理员')
    .action(async ({ options }, player) => {
      if (options.r) {
        if (!player) return '请输入玩家名'
        return await executeRconCommand(
          `deop ${player}`,
          config.info.defaultRcon,
          config.info.rconPassword
        )
      }

      if (player) {
        return await executeRconCommand(
          `op ${player}`,
          config.info.defaultRcon,
          config.info.rconPassword
        )
      } else {
        return '请输入玩家名'
      }
    })

  mcrun.subcommand('kick <player:string> [reason:text]', '踢出指定玩家', { authority: 2 })
    .action(async ({ }, player, reason) => {
      if (!player) return '请输入玩家名'
      const command = reason ? `kick ${player} ${reason}` : `kick ${player}`
      return await executeRconCommand(
        command,
        config.info.defaultRcon,
        config.info.rconPassword
      )
    })

  mcrun.subcommand('ban <player:string> [reason:text]', '封禁指定玩家', { authority: 3 })
    .option('ip', '--ip  封禁IP地址')
    .usage('mcrun ban <玩家名> [理由] - 封禁指定玩家')
    .usage('mcrun ban --ip <IP地址> [理由] - 封禁指定IP地址')
    .action(async ({ options }, player, reason) => {
      if (!player) return '请输入玩家名或IP地址'

      let cmdBase = options.ip ? 'ban-ip' : 'ban'
      const command = reason ? `${cmdBase} ${player} ${reason}` : `${cmdBase} ${player}`

      return await executeRconCommand(
        command,
        config.info.defaultRcon,
        config.info.rconPassword
      )
    })

  mcrun.subcommand('run <command:text>', '执行自定义命令', { authority: 3 })
    .usage('mcrun run <命令> - 在服务器执行自定义命令')
    .action(async ({ }, command) => {
      return await executeRconCommand(
        command,
        config.info.defaultRcon,
        config.info.rconPassword
      )
    })
}
