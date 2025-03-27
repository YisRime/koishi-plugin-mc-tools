import { Session } from 'koishi'
import { MinecraftToolsConfig } from './index'
import {
  autoRecall,
  executeRconCommand,
  checkGroupPermission,
  broadcastToMinecraft,
  sendPrivateMessageToPlayer,
  sendTitleToMinecraft,
  sendActionbarToMinecraft
} from './linkservice'

/**
 * 注册服务器相关命令
 */
export function registerServerCommands(parent: any, config: MinecraftToolsConfig, ctx?: any) {
  // 主命令
  const mcserver = parent.subcommand('.server', 'Minecraft 服务器管理')
    .usage('mc.server - Minecraft 服务器相关命令')
    .before(({ session }) => {
      // 检查群组权限
      if (!checkGroupPermission(session, config.link.group)) {
        return autoRecall('此群组没有权限执行命令', session)
      }
    })

  // 发送消息命令
  mcserver.subcommand('.say <message:text>', '发送消息到服务器')
    .usage('mc.server.say <消息> - 发送消息到 Minecraft 服务器')
    .action(async ({ session }, message) => {
      if (!message) return autoRecall('请输入要发送的消息', session)
      // 获取用户昵称或ID
      const userIdentifier = session.username || session.userId

      // 如果启用WebSocket，则使用WebSocket发送
      if (config.link.enableWebSocket) {
        const formatted = `${userIdentifier}: ${message}`
        return broadcastToMinecraft(formatted, 'white', session) ?
          autoRecall('消息已发送', session) :
          autoRecall('消息发送失败', session)
      }
      // 否则使用RCON
      return executeRconCommand(`say ${userIdentifier}: ${message}`, config, session)
    })

  // 执行自定义命令
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .usage('mc.server.run <命令> - 执行自定义 Minecraft 命令')
    .action(({ session }, command) => {
      return command ? executeRconCommand(command, config, session) :
                     autoRecall('请输入要执行的命令', session)
    })

  // 如果启用了WebSocket，添加更多命令
  if (config.link.enableWebSocket) {
    // 广播命令
    mcserver.subcommand('.broadcast <message:text>', '广播消息到服务器')
      .alias('.bc')
      .usage('mc.server.broadcast <消息> - 以更醒目的方式广播消息')
      .option('color', '-c <color:string> 消息颜色', { fallback: 'gold' })
      .action(async ({ session, options }, message) => {
        if (!message) return autoRecall('请输入要广播的消息', session)
        return broadcastToMinecraft(message, options.color, session) ?
          autoRecall('广播已发送', session) :
          autoRecall('广播发送失败', session)
      })

    // 私聊命令
    mcserver.subcommand('.msg <player:string> <message:text>', '向玩家发送私聊')
      .usage('mc.server.msg <玩家> <消息> - 向特定玩家发送私聊消息')
      .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
      .action(async ({ session, options }, player, message) => {
        if (!player) return autoRecall('请指定玩家', session)
        if (!message) return autoRecall('请输入要发送的消息', session)

        const userIdentifier = session.username || session.userId
        const formattedMsg = `来自 ${userIdentifier} 的消息: ${message}`

        return sendPrivateMessageToPlayer(player, formattedMsg, options.color, session) ?
          autoRecall('私聊消息已发送', session) :
          autoRecall('私聊消息发送失败', session)
      })

    // 标题命令
    mcserver.subcommand('.title <title:text> [subtitle:text]', '发送标题到服务器')
      .usage('mc.server.title <标题> [副标题] - 向所有玩家发送标题')
      .option('fadein', '-i <time:number> 淡入时间', { fallback: 10 })
      .option('stay', '-s <time:number> 停留时间', { fallback: 70 })
      .option('fadeout', '-o <time:number> 淡出时间', { fallback: 20 })
      .action(async ({ session, options }, title, subtitle) => {
        if (!title) return autoRecall('请输入标题内容', session)

        return sendTitleToMinecraft(
          title, subtitle || '', options.fadein, options.stay, options.fadeout, session
        ) ? autoRecall('标题已发送', session) : autoRecall('标题发送失败', session)
      })

    // 动作栏命令
    mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
      .alias('.ab')
      .usage('mc.server.actionbar <消息> - 发送动作栏消息到服务器')
      .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
      .action(async ({ session, options }, message) => {
        if (!message) return autoRecall('请输入要发送的消息', session)

        return sendActionbarToMinecraft(message, options.color, session) ?
          autoRecall('动作栏消息已发送', session) :
          autoRecall('动作栏消息发送失败', session)
      })
  }
}
