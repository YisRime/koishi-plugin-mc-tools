import { Session } from 'koishi'
import { MinecraftToolsConfig } from './index'
import {
  sendTempMessage,
  executeRconCommand,
  hasGroupPermission,
  createMcText,
  sendMinecraftMessage
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
        const success = await sendMinecraftMessage('chat', formattedMessage, { session, feedback: false })

        // 如果WebSocket发送失败且RCON可用，尝试使用RCON
        if (!success && config.link.enableRcon) {
          await executeRconCommand(`say ${sender}: ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('消息发送失败', session)
        } else {
          await sendTempMessage('消息已发送', session)
        }
      } else {
        // 直接使用RCON
        await executeRconCommand(`say ${sender}: ${message}`, config, session)
      }
    })

  // 执行自定义命令
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .usage('mc.server.run <命令> - 执行自定义 Minecraft 命令')
    .action(({ session }, command) => {
      if (!command) return sendTempMessage('请输入要执行的命令', session)
      executeRconCommand(command, config, session)
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

        const success = await sendMinecraftMessage('broadcast', formattedMessage, { session, feedback: false })

        // 如果WebSocket发送失败且RCON可用，尝试使用RCON
        if (!success && config.link.enableRcon) {
          // 在RCON中模拟广播（不同服务端可能有不同实现）
          await executeRconCommand(`broadcast ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('广播发送失败', session)
        } else {
          await sendTempMessage('广播已发送', session)
        }
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

        const success = await sendMinecraftMessage('whisper', formattedMsg, { player, session, feedback: false })

        // 如果WebSocket发送失败且RCON可用，尝试使用RCON
        if (!success && config.link.enableRcon) {
          await executeRconCommand(`tell ${player} ${sender}: ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('私聊消息发送失败', session)
        } else {
          await sendTempMessage('私聊消息已发送', session)
        }
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

        const success = await sendMinecraftMessage('title', titleText, {
          subtitle: subtitleText,
          fadein: options.fadein,
          stay: options.stay,
          fadeout: options.fadeout,
          session,
          feedback: false
        })

        // 如果WebSocket发送失败且RCON可用，尝试使用RCON
        if (!success && config.link.enableRcon) {
          // 使用原版命令发送标题
          await executeRconCommand(`title @a title {"text":"${title}","color":"${options.color}"}`, config, session)
          if (subtitle) {
            await executeRconCommand(`title @a subtitle {"text":"${subtitle}","color":"${options.subcolor}"}`, config, session)
          }
          await executeRconCommand(`title @a times ${options.fadein} ${options.stay} ${options.fadeout}`, config, session)
          await sendTempMessage('标题已发送', session)
        } else if (!success) {
          await sendTempMessage('标题发送失败', session)
        } else {
          await sendTempMessage('标题已发送', session)
        }
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

        const success = await sendMinecraftMessage('actionbar', actionbarText, { session, feedback: false })

        // 如果WebSocket发送失败且RCON可用，尝试使用RCON
        if (!success && config.link.enableRcon) {
          // 使用原版命令发送动作栏消息
          await executeRconCommand(`title @a actionbar {"text":"${message}","color":"${options.color}","bold":${options.bold}}`, config, session)
          await sendTempMessage('动作栏消息已发送', session)
        } else if (!success) {
          await sendTempMessage('动作栏消息发送失败', session)
        } else {
          await sendTempMessage('动作栏消息已发送', session)
        }
      })
  }
}
