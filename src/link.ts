import { MTConfig } from './index'
import {
  sendTempMessage,
  executeRconCommand,
  createMcText,
  sendMinecraftMessage
} from './linkservice'

/**
 * 注册服务器相关命令
 * @param parent - 父命令对象，用于挂载子命令
 * @param config - MC-Tools 配置对象
 * @returns void
 */
export function registerServerCommands(parent: any, config: MTConfig) {
  /**
   * 主服务器命令组
   */
  const mcserver = parent.subcommand('.server', 'Minecraft 服务器管理')
    .usage('mc.server - Minecraft 服务器相关命令')
    .before(({ session }) => {
      if (!config.link.group || !session) return false
      const currentGroup = `${session.platform}:${session.guildId}`
      if (currentGroup !== config.link.group) return false
    })

  /**
   * 发送普通消息到服务器
   */
  mcserver.subcommand('.say <message:text>', '发送消息到服务器')
    .usage('mc.server.say <消息> - 发送消息到 Minecraft 服务器')
    .action(async ({ session }, message) => {
      if (!message) return sendTempMessage('请输入消息', session)
      const sender = session.username || session.userId
      if (config.link.enableWebSocket) {
        const formattedMessage = createMcText(`${sender}: ${message}`)
        const success = await sendMinecraftMessage('chat', formattedMessage, { session, feedback: false })
        if (!success && config.link.enableRcon) {
          await executeRconCommand(`say ${sender}: ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('消息发送失败', session)
        } else {
          await sendTempMessage('消息发送成功', session)
        }
      } else {
        await executeRconCommand(`say ${sender}: ${message}`, config, session)
      }
    })

  /**
   * 执行服务器命令
   */
  mcserver.subcommand('.run <command:text>', '执行自定义命令')
    .usage('mc.server.run <命令> - 执行自定义 Minecraft 命令')
    .action(({ session }, command) => {
      if (!command) return sendTempMessage('请输入命令', session)
      executeRconCommand(command, config, session)
    })

  if (config.link.enableWebSocket) {
    /**
     * 广播消息到服务器
     * 支持文本样式和交互功能
     */
    mcserver.subcommand('.broadcast <message:text>', '广播消息到服务器')
      .alias('.bc')
      .usage('mc.server.broadcast <消息> - 以更醒目的方式广播消息')
      .option('color', '-c <color:string> 消息颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '-i 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('strikethrough', '-s 使用删除线')
      .option('obfuscated', '-o 使用混淆效果')
      .option('font', '-f <font:string> 使用自定义字体')
      .option('insertion', '--insert <text:string> 点击插入文本')
      .option('url', '--url <url:string> 点击打开URL')
      .option('command', '--cmd <command:string> 点击执行命令')
      .option('suggest', '--suggest <command:string> 点击提示命令')
      .option('copy', '--copy <text:string> 点击复制文本')
      .option('hoverText', '--hover <text:string> 鼠标悬停显示文本')
      .option('hoverItem', '--item <id:string> 鼠标悬停显示物品')
      .option('hoverEntity', '--entity <id:string> 鼠标悬停显示实体')
      .action(async ({ session, options }, message) => {
        if (!message) return sendTempMessage('请输入消息', session)
        const styles: any = {};
        if (options.color) styles.color = options.color;
        if ('bold' in options) styles.bold = options.bold;
        if ('italic' in options) styles.italic = options.italic;
        if ('underlined' in options) styles.underlined = options.underlined;
        if ('strikethrough' in options) styles.strikethrough = options.strikethrough;
        if ('obfuscated' in options) styles.obfuscated = options.obfuscated;
        if (options.font) styles.font = options.font;
        if (options.insertion) styles.insertion = options.insertion;
        if (options.url) {
          styles.clickEvent = { action: 'open_url', value: options.url };
        } else if (options.command) {
          styles.clickEvent = { action: 'run_command', value: options.command };
        } else if (options.suggest) {
          styles.clickEvent = { action: 'suggest_command', value: options.suggest };
        } else if (options.copy) {
          styles.clickEvent = { action: 'copy_to_clipboard', value: options.copy };
        }
        if (options.hoverText) {
          styles.hoverEvent = {
            action: 'show_text',
            contents: options.hoverText
          };
        } else if (options.hoverItem) {
          styles.hoverEvent = {
            action: 'show_item',
            item: { id: options.hoverItem }
          };
        } else if (options.hoverEntity) {
          styles.hoverEvent = {
            action: 'show_entity',
            entity: { id: options.hoverEntity }
          };
        }
        const hasStyles = Object.keys(styles).length > 0;
        const formattedMessage = hasStyles ? createMcText(message, styles) : message;
        const success = await sendMinecraftMessage('broadcast', formattedMessage, { session, feedback: false })
        if (!success && config.link.enableRcon) {
          await executeRconCommand(`broadcast ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('广播发送失败', session)
        } else {
          await sendTempMessage('广播发送成功', session)
        }
      })

    /**
     * 向特定玩家发送私聊消息
     * 支持文本样式和交互功能
     */
    mcserver.subcommand('.tell <player:string> <message:text>', '向玩家发送私聊消息')
      .usage('mc.server.tell <玩家> <消息> - 向特定玩家发送私聊消息')
      .option('color', '-c <color:string> 消息颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '-i 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('strikethrough', '-s 使用删除线')
      .option('obfuscated', '-o 使用混淆效果')
      .option('font', '-f <font:string> 使用自定义字体')
      .option('url', '--url <url:string> 点击打开URL')
      .option('command', '--cmd <command:string> 点击执行命令')
      .option('suggest', '--suggest <command:string> 点击提示命令')
      .option('copy', '--copy <text:string> 点击复制文本')
      .option('hoverText', '--hover <text:string> 鼠标悬停显示文本')
      .action(async ({ session, options }, player, message) => {
        if (!player || player.length === 0) return sendTempMessage('请指定玩家', session)
        if (!message) return sendTempMessage('请输入消息', session)
        const sender = session.username || session.userId
        const styles: any = {};
        if (options.color) styles.color = options.color;
        if ('bold' in options) styles.bold = options.bold;
        if ('italic' in options) styles.italic = options.italic;
        if ('underlined' in options) styles.underlined = options.underlined;
        if ('strikethrough' in options) styles.strikethrough = options.strikethrough;
        if ('obfuscated' in options) styles.obfuscated = options.obfuscated;
        if (options.font) styles.font = options.font;
        if (options.url) {
          styles.clickEvent = { action: 'open_url', value: options.url };
        } else if (options.command) {
          styles.clickEvent = { action: 'run_command', value: options.command };
        } else if (options.suggest) {
          styles.clickEvent = { action: 'suggest_command', value: options.suggest };
        } else if (options.copy) {
          styles.clickEvent = { action: 'copy_to_clipboard', value: options.copy };
        }
        if (options.hoverText) {
          styles.hoverEvent = {
            action: 'show_text',
            contents: options.hoverText
          };
        }
        const messageText = `来自 ${sender} 的消息: ${message}`;
        const hasStyles = Object.keys(styles).length > 0;
        const formattedMsg = hasStyles ? createMcText(messageText, styles) : messageText;
        const success = await sendMinecraftMessage('whisper', formattedMsg, {
          player,
          session,
          feedback: false
        })
        if (!success && config.link.enableRcon) {
          await executeRconCommand(`tell ${player} ${sender}: ${message}`, config, session)
        } else if (!success) {
          await sendTempMessage('私聊消息发送失败', session)
        } else {
          await sendTempMessage('私聊消息发送成功', session)
        }
      })

    /**
     * 向所有玩家发送标题和副标题
     * 支持自定义显示时间和文本样式
     */
    mcserver.subcommand('.title <title:text> [subtitle:text]', '发送标题到服务器')
      .usage('mc.server.title <标题> [副标题] - 向所有玩家发送标题')
      .option('fadein', '-i <time:number> 淡入时间')
      .option('stay', '-s <time:number> 停留时间')
      .option('fadeout', '-o <time:number> 淡出时间')
      .option('color', '-c <color:string> 标题颜色')
      .option('subcolor', '-sc <color:string> 副标题颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '--italic 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('subbold', '--sb 副标题使用粗体')
      .option('subitalic', '--si 副标题使用斜体')
      .option('subunderlined', '--su 副标题使用下划线')
      .action(async ({ session, options }, title, subtitle) => {
        if (!title) return sendTempMessage('请输入标题', session)
        const titleStyles: any = {};
        if (options.color) titleStyles.color = options.color;
        if ('bold' in options) titleStyles.bold = options.bold;
        if ('italic' in options) titleStyles.italic = options.italic;
        if ('underlined' in options) titleStyles.underlined = options.underlined;
        const subtitleStyles: any = {};
        if (options.subcolor) subtitleStyles.color = options.subcolor;
        if ('subbold' in options) subtitleStyles.bold = options.subbold;
        if ('subitalic' in options) subtitleStyles.italic = options.subitalic;
        if ('subunderlined' in options) subtitleStyles.underlined = options.subunderlined;
        const titleText = Object.keys(titleStyles).length > 0 ?
          createMcText(title, titleStyles) : title;
        const subtitleText = subtitle && Object.keys(subtitleStyles).length > 0 ?
          createMcText(subtitle, subtitleStyles) : subtitle || '';
        const fadein = options.fadein !== undefined ? options.fadein : 10;
        const stay = options.stay !== undefined ? options.stay : 70;
        const fadeout = options.fadeout !== undefined ? options.fadeout : 20;
        const success = await sendMinecraftMessage('title', titleText, {
          subtitle: subtitleText,
          fadein,
          stay,
          fadeout,
          session,
          feedback: false
        })
        if (!success && config.link.enableRcon) {
          const titleColor = options.color || 'gold';
          const subtitleColor = options.subcolor || 'yellow';
          await executeRconCommand(`title @a title {"text":"${title}","color":"${titleColor}"}`, config, session)
          if (subtitle) {
            await executeRconCommand(`title @a subtitle {"text":"${subtitle}","color":"${subtitleColor}"}`, config, session)
          }
          await executeRconCommand(`title @a times ${fadein} ${stay} ${fadeout}`, config, session)
          await sendTempMessage('标题发送成功', session)
        } else if (!success) {
          await sendTempMessage('标题发送失败', session)
        } else {
          await sendTempMessage('标题发送成功', session)
        }
      })

    /**
     * 发送动作栏消息（显示在屏幕底部）
     * 支持文本样式
     */
    mcserver.subcommand('.actionbar <message:text>', '发送动作栏消息')
      .alias('.ab')
      .usage('mc.server.actionbar <消息> - 发送动作栏消息到服务器')
      .option('color', '-c <color:string> 消息颜色')
      .option('bold', '-b 使用粗体')
      .option('italic', '-i 使用斜体')
      .option('underlined', '-u 使用下划线')
      .option('strikethrough', '-s 使用删除线')
      .option('obfuscated', '-o 使用混淆效果')
      .action(async ({ session, options }, message) => {
        if (!message) return sendTempMessage('请输入消息', session)
        const styles: any = {};
        if (options.color) styles.color = options.color;
        if ('bold' in options) styles.bold = options.bold;
        if ('italic' in options) styles.italic = options.italic;
        if ('underlined' in options) styles.underlined = options.underlined;
        if ('strikethrough' in options) styles.strikethrough = options.strikethrough;
        if ('obfuscated' in options) styles.obfuscated = options.obfuscated;
        const hasStyles = Object.keys(styles).length > 0;
        const actionbarText = hasStyles ? createMcText(message, styles) : message;
        const success = await sendMinecraftMessage('actionbar', actionbarText, { session, feedback: false })
        if (!success && config.link.enableRcon) {
          const color = options.color || 'white';
          const bold = options.bold || false;
          await executeRconCommand(`title @a actionbar {"text":"${message}","color":"${color}","bold":${bold}}`, config, session)
          await sendTempMessage('动作栏消息发送成功', session)
        } else if (!success) {
          await sendTempMessage('动作栏消息发送失败', session)
        } else {
          await sendTempMessage('动作栏消息发送成功', session)
        }
      })

    /**
     * 发送JSON格式的复杂消息
     * 允许直接传入原始JSON格式
     */
    mcserver.subcommand('.json <jsonText:text>', '发送JSON格式消息')
      .usage('mc.server.json <JSON文本> - 发送复杂的JSON格式消息')
      .option('type', '-t <type:string> 消息类型 (chat/broadcast/whisper/title/actionbar)')
      .option('player', '-p <player:string> 玩家名称或UUID (whisper类型使用)')
      .action(async ({ session, options }, jsonText) => {
        if (!jsonText) return sendTempMessage('请输入消息', session)
        try {
          const messageObj = JSON.parse(jsonText);
          const msgType = options.type as 'chat' | 'broadcast' | 'whisper' | 'title' | 'actionbar' || 'broadcast';
          let success = false;
          if (msgType === 'whisper' && !options.player) {
            return sendTempMessage('请指定玩家', session);
          }
          success = await sendMinecraftMessage(msgType, messageObj, {
            player: options.player,
            session,
            feedback: false
          });
          if (!success) {
            return sendTempMessage('消息发送失败', session);
          }
          await sendTempMessage(`消息发送成功`, session);
        } catch (error) {
          await sendTempMessage(`JSON解析失败: ${error.message}`, session);
        }
      })
  }
}
