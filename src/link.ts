import { Session } from 'koishi'
import { MinecraftToolsConfig } from './index'
import {
  sendTempMessage,
  executeRconCommand,
  hasGroupPermission,
  sendChatMessage,
  broadcastToServer,
  whisperToPlayer,
  sendTitle,
  sendActionbar,
  createMcText
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
      if (!hasGroupPermission(session, config.link.group)) {
        return sendTempMessage('此群组没有权限执行命令', session)
      }
    })

  // 发送消息命令
  mcserver.subcommand('.say <message:text>', '发送消息到服务器')
    .usage('mc.server.say <消息> - 发送消息到 Minecraft 服务器')
    .action(async ({ session }, message) => {
      if (!message) return sendTempMessage('请输入要发送的消息', session)
      // 获取用户昵称或ID
      const sender = session.username || session.userId

      // 如果启用WebSocket，则使用WebSocket发送
      if (config.link.enableWebSocket) {
        const formattedMessage = createMcText(`${sender}: ${message}`)
        return sendChatMessage(formattedMessage, session)
      }
      // 否则使用RCON
      return executeRconCommand(`say ${sender}: ${message}`, config, session)
    })

  // 执行自定义命令
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .usage('mc.server.run <命令> - 执行自定义 Minecraft 命令')
    .action(({ session }, command) => {
      return command ? executeRconCommand(command, config, session) :
                     sendTempMessage('请输入要执行的命令', session)
    })

  // 如果启用了WebSocket，添加更多命令
  if (config.link.enableWebSocket) {
    // 广播命令
    mcserver.subcommand('.broadcast <message:text>', '广播消息到服务器')
      .alias('.bc')
      .usage('mc.server.broadcast <消息> - 以更醒目的方式广播消息')
      .option('color', '-c <color:string> 消息颜色', { fallback: 'gold' })
      .option('bold', '-b 使用粗体', { fallback: false })
      .option('italic', '-i 使用斜体', { fallback: false })
      .option('underlined', '-u 使用下划线', { fallback: false })
      .action(async ({ session, options }, message) => {
        if (!message) return sendTempMessage('请输入要广播的消息', session)

        const formattedMessage = createMcText(message, {
          color: options.color,
          bold: options.bold,
          italic: options.italic,
          underlined: options.underlined
        })

        return broadcastToServer(formattedMessage, session)
      })

    // 私聊命令
    mcserver.subcommand('.tell <player:string> <message:text>', '向玩家发送私聊')
      .usage('mc.server.tell <玩家> <消息> - 向特定玩家发送私聊消息')
      .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
      .option('bold', '-b 使用粗体', { fallback: false })
      .option('italic', '-i 使用斜体', { fallback: false })
      .action(async ({ session, options }, player, message) => {
        if (!player) return sendTempMessage('请指定玩家', session)
        if (!message) return sendTempMessage('请输入要发送的消息', session)

        const sender = session.username || session.userId
        const formattedMsg = createMcText(`来自 ${sender} 的消息: ${message}`, {
          color: options.color,
          bold: options.bold,
          italic: options.italic
        })

        return whisperToPlayer(player, formattedMsg, session)
      })

    // 标题命令
    mcserver.subcommand('.title <title:text> [subtitle:text]', '发送标题到服务器')
      .usage('mc.server.title <标题> [副标题] - 向所有玩家发送标题')
      .option('fadein', '-i <time:number> 淡入时间', { fallback: 10 })
      .option('stay', '-s <time:number> 停留时间', { fallback: 70 })
      .option('fadeout', '-o <time:number> 淡出时间', { fallback: 20 })
      .option('color', '-c <color:string> 标题颜色', { fallback: 'gold' })
      .option('subcolor', '-sc <color:string> 副标题颜色', { fallback: 'yellow' })
      .action(async ({ session, options }, title, subtitle) => {
        if (!title) return sendTempMessage('请输入标题内容', session)

        const titleText = createMcText(title, { color: options.color })
        const subtitleText = subtitle ? createMcText(subtitle, { color: options.subcolor }) : ''

        return sendTitle(
          titleText, subtitleText, options.fadein, options.stay, options.fadeout, session
        )
      })

    // 动作栏命令
    mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
      .alias('.ab')
      .usage('mc.server.actionbar <消息> - 发送动作栏消息到服务器')
      .option('color', '-c <color:string> 消息颜色', { fallback: 'white' })
      .option('bold', '-b 使用粗体', { fallback: false })
      .action(async ({ session, options }, message) => {
        if (!message) return sendTempMessage('请输入要发送的消息', session)

        const actionbarText = createMcText(message, {
          color: options.color,
          bold: options.bold
        })

        return sendActionbar(actionbarText, session)
      })
  }
}
