import { Context } from 'koishi'
import { Config } from '../index'
import { executeRconCommand, findServer, sendMinecraftMessage, formatMinecraftText } from './service'
import { FileManager } from '../utils/fileManager'

/**
 * 处理服务器命令前的通用逻辑
 * @param {Object} ctx - 命令上下文对象
 * @param {Config} config - 插件配置
 * @returns {boolean} 是否通过前置检查
 */
function setupServerIdBefore({ session, options }, config: Config) {
  if (!session) return false;
  if (!options.server) {
    const mapping = config.serverMaps.find(m => m.platform === session.platform && m.channelId === session.guildId);
    if (!mapping) {
      session.send('该群组未配置对应服务器');
      return false;
    }
    options.server = mapping.serverId;
  }
  return true;
}

/**
 * 验证服务器和构造消息的辅助函数
 * @param {Object} ctx - 命令上下文对象
 * @param {Object} ctx.session - Koishi会话对象
 * @param {Object} ctx.options - 命令选项
 * @param {Config} config - 插件配置
 * @param {string} messageType - 消息类型
 * @param {any} message - 消息内容
 * @param {Object} additionalData - 额外的消息参数
 * @returns {Promise<Object|boolean>} 处理结果
 */
async function verifyAndSendMessage({ session, options }, config: Config, messageType, message, additionalData = {}) {
  const serverId = options.server;
  const serverInfo = findServer(config, serverId);
  if (!serverInfo.found || (!serverInfo.wsConfig && !serverInfo.rconConfig)) {
    await session.send(`未找到服务器 #${serverInfo.id}`);
    return false;
  }
  const { id, wsConfig, rconConfig } = serverInfo;
  let success = false;
  if (wsConfig) success = await sendMinecraftMessage(messageType, message, {...additionalData, session, serverId: id, feedback: false});
  return { success, serverInfo, rconConfig };
}

/**
 * 注册服务器相关命令
 * @param {Context} ctx - Koishi上下文
 * @param {any} parent - 父命令实例
 * @param {Config} config - 插件配置
 */
export function registerServer(ctx: Context, parent: any, config: Config) {
  const server = parent.subcommand('.server', '管理 Minecraft 服务器')
    .usage('mc.server - 向 Minecraft 服务器内发送消息和执行命令');

  server.subcommand('.say <message:text>', '发送聊天消息')
    .usage('mc.server.say <消息内容> - 发送消息到 Minecraft 服务器')
    .option('server', '-s <serverId:number> 指定服务器 ID')
    .option('format', '-f <format:string> 指定消息文本格式')
    .before(ctx => setupServerIdBefore(ctx, config))
    .action(async ({ session, options }, message) => {
      if (!message) return session.send('请输入要发送的消息');
      const sender = session.username || session.userId;
      const messageText = `${sender}: ${message}`;
      const { text: formattedMessage } = formatMinecraftText(messageText, options);
      const result = await verifyAndSendMessage({ session, options }, config, 'chat', formattedMessage);
      if (!result) return;
      const { success, serverInfo, rconConfig } = result;
      if (!success && rconConfig) {
        await executeRconCommand(`say ${sender}: ${message}`, rconConfig, session);
      } else {
        await session.send(success ?
          `已发送消息 [#${serverInfo.id}]` :
          `消息发送失败 [#${serverInfo.id}]`);
      }
    });
  server.subcommand('.run <command:text>', '执行命令')
    .usage('mc.server.run <命令内容> - 执行指定 Minecraft 命令')
    .option('server', '-s <serverId:number> 指定服务器 ID')
    .before(ctx => setupServerIdBefore(ctx, config))
    .action(({ session, options }, command) => {
      if (!command) return session.send('请输入要执行的命令');
      const serverId = options.server as number;
      const serverInfo = findServer(config, serverId);
      if (!serverInfo.found) return session.send(`未找到服务器 #${serverId}`);
      const { rconConfig } = serverInfo;
      if (rconConfig) {
        executeRconCommand(command, rconConfig, session);
      } else {
        session.send(`服务器 #${serverId} 未配置 RCON`);
      }
    });
  // WebSocket 相关命令
  if (config.wsServers.length > 0) {
    server.subcommand('.broadcast <message:text>', '发送全服广播')
      .usage('mc.server.broadcast <广播内容> - 向在线玩家发送醒目广播')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('format', '-f <format:string> 指定广播文本格式')
      .before(ctx => setupServerIdBefore(ctx, config))
      .action(async ({ session, options }, message) => {
        if (!message) return session.send('请输入要广播的消息');
        const { text: formattedMessage } = formatMinecraftText(message, options);
        const result = await verifyAndSendMessage({ session, options }, config, 'broadcast', formattedMessage);
        if (!result) return;
        const { success, serverInfo, rconConfig } = result;
        if (!success && rconConfig) {
          await executeRconCommand(`broadcast ${message}`, rconConfig, session);
        } else {
          await session.send(success ?
            `已发送广播 [#${serverInfo.id}]` :
            `广播发送失败 [#${serverInfo.id}]`);
        }
      });
    server.subcommand('.tell <player:string> <message:text>', '发送私聊给玩家')
      .usage('mc.server.tell <玩家名称> <消息内容> - 向特定玩家发送私聊消息')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('format', '-f <format:string> 指定私聊文本格式')
      .before(ctx => setupServerIdBefore(ctx, config))
      .action(async ({ session, options }, player, message) => {
        if (!player || !player.length) return session.send('请输入玩家名称');
        if (!message) return session.send('请输入要发送的消息');
        const sender = session.username || session.userId;
        const messageText = `来自 ${sender} 的消息: ${message}`;
        const { text: formattedMessage } = formatMinecraftText(messageText, options);
        const result = await verifyAndSendMessage({ session, options }, config, 'whisper', formattedMessage, { player });
        if (!result) return;
        const { success, serverInfo, rconConfig } = result;
        if (!success && rconConfig) {
          await executeRconCommand(`tell ${player} ${sender}: ${message}`, rconConfig, session);
        } else {
          await session.send(success ?
            `已发送私聊 [#${serverInfo.id}]` :
            `私聊发送失败 [#${serverInfo.id}]`);
        }
      });
    server.subcommand('.title <title:text> [subtitle:text]', '发送屏幕标题')
      .usage('mc.server.title <主标题> [副标题] - 在屏幕中央显示大型标题')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('format', '-f <format:string> 指定主标题文本格式')
      .option('subformat', '--sf <format:string> 指定副标题文本格式')
      .before(ctx => setupServerIdBefore(ctx, config))
      .action(async ({ session, options }, title, subtitle) => {
        if (!title) return session.send('请输入要显示的标题');
        const { text: formattedTitle, timeParams } = formatMinecraftText(title, options);
        const { text: formattedSubtitle } = subtitle ? formatMinecraftText(subtitle, options, true) : { text: '' };
        const { fadein, stay, fadeout } = timeParams;
        const result = await verifyAndSendMessage({ session, options }, config, 'title', formattedTitle, {subtitle: formattedSubtitle, fadein, stay, fadeout});
        if (!result) return;
        const { success, serverInfo, rconConfig } = result;
        if (!success && rconConfig) {
          const toJson = (text, formatted) => {
            if (typeof formatted === 'string') return `{"text":"${text}"}`;
            if (formatted.type === 'text') return JSON.stringify(formatted.data);
            return `{"text":"${text}"}`;
          };
          await executeRconCommand(`title @a title ${toJson(title, formattedTitle)}`, rconConfig, session);
          if (subtitle) {
            await executeRconCommand(`title @a subtitle ${toJson(subtitle, formattedSubtitle)}`, rconConfig, session);
          }
          if (fadein !== undefined && stay !== undefined && fadeout !== undefined) {
            await executeRconCommand(`title @a times ${fadein} ${stay} ${fadeout}`, rconConfig, session);
          }
          await session.send(`已发送标题 [#${serverInfo.id}]`);
        } else {
          await session.send(success ?
            `已发送标题 [#${serverInfo.id}]` :
            `标题发送失败 [#${serverInfo.id}]`);
        }
      });
    server.subcommand('.actionbar <message:text>', '发送动作栏消息')
      .usage('mc.server.actionbar <消息内容> - 在物品栏上方显示提示消息')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('format', '-f <format:string> 指定文本格式')
      .before(ctx => setupServerIdBefore(ctx, config))
      .action(async ({ session, options }, message) => {
        if (!message) return session.send('请输入要显示的动作栏消息');
        const { text: formattedMessage } = formatMinecraftText(message, options);
        const result = await verifyAndSendMessage({ session, options }, config, 'actionbar', formattedMessage);
        if (!result) return;
        const { success, serverInfo, rconConfig } = result;
        if (!success && rconConfig) {
          let jsonText = typeof formattedMessage === 'string'
            ? `{"text":"${message}"}`
            : (formattedMessage.type === 'text'
              ? JSON.stringify(formattedMessage.data)
              : `{"text":"${message}"}`);
          await executeRconCommand(`title @a actionbar ${jsonText}`, rconConfig, session);
        } else {
          await session.send(success ?
            `已发送动作栏 [#${serverInfo.id}]` :
            `动作栏发送失败 [#${serverInfo.id}]`);
        }
      });
    server.subcommand('.json <jsonText:text>', '发送 JSON 消息')
      .usage('mc.server.json <JSON文本> - 发送自定义 JSON 消息')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('type', '-t <type:string> 指定消息类型 (chat/broadcast/whisper/title/actionbar)')
      .option('player', '-p <player:string> 指定玩家')
      .before(ctx => setupServerIdBefore(ctx, config))
      .action(async ({ session, options }, jsonText) => {
        if (!jsonText) return session.send('请输入 JSON 文本');
        const serverId = options.server as number;
        const serverInfo = findServer(config, serverId);
        if (!serverInfo.found || !serverInfo.wsConfig)
          return session.send(`服务器 #${serverId} 配置错误`);
        try {
          const messageObj = JSON.parse(jsonText);
          const msgType = (options.type as any) || 'broadcast';
          if (msgType === 'whisper' && !options.player)
            return session.send('请指定玩家名');
          const success = await sendMinecraftMessage(msgType, messageObj, {
            player: options.player, session, serverId, feedback: false
          });
          await session.send(success ?
            `已发送 JSON [#${serverId}]` :
            `JSON 发送失败 [#${serverId}]`);
        } catch (error) {
          await session.send(`JSON 解析失败 - ${error.message}`);
        }
      });
  }
  // 白名单命令
  if (config.bindEnabled) { const fileManager = new FileManager(ctx);
    server.subcommand('.bind [username:string]', '白名单管理')
      .usage('mc.server.bind [用户名] - 绑定或解绑 Minecraft 用户名')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('remove', '-r 解绑指定用户名')
      .action(async ({ session, options }, username) => {
        if (!session) return
        const bindings = await fileManager.getWhitelistBindings()
        const userId = session.userId
        // 显示已绑定列表
        if (!username) {
          if (!bindings[userId] || Object.keys(bindings[userId]).length === 0) return session.send('未绑定任何用户名')
          const bindingList = Object.entries(bindings[userId])
            .map(([name, serverId]) => `${name} → 服务器#${serverId}`).join('\n')
          return session.send(`已绑定的用户名：\n${bindingList}`)
        }
        // 解绑模式
        if (options.remove) {
          if (!bindings[userId] || !bindings[userId][username]) return session.send(`未找到绑定用户名 ${username}`)
          const serverId = bindings[userId][username]
          const serverInfo = findServer(config, serverId)
          if (!serverInfo.found || !serverInfo.rconConfig) return session.send(`服务器 #${serverId} 不存在或未配置RCON`)
          try {
            await executeRconCommand(`whitelist remove ${username}`, serverInfo.rconConfig, session)
            delete bindings[userId][username]
            if (Object.keys(bindings[userId]).length === 0) delete bindings[userId]
            await fileManager.saveWhitelistBindings(bindings)
            return session.send(`已解绑用户名 ${username} [#${serverId}]`)
          } catch (error) {
            ctx.logger.warn(`白名单移除失败: ${error.message} [#${serverId}]`)
            return session.send(`白名单移除失败，未解除绑定: ${error.message} [#${serverId}]`)
          }
        }
        // 绑定模式
        if (username.length < 3 || username.length > 16) return session.send('无效的用户名')
        // 获取服务器ID
        const serverId = options.server ||
          config.serverMaps.find(m => m.platform === session.platform && m.channelId === session.channelId)?.serverId
        if (!serverId) return session.send('该群组未配置对应服务器')
        const serverInfo = findServer(config, serverId)
        if (!serverInfo.found) return session.send(`未找到服务器 #${serverId}`)
        if (!serverInfo.rconConfig) return session.send(`服务器 #${serverId} 未配置 RCON`)
        // 检查该用户名是否已被绑定到其他服务器
        for (const [uid, userBindings] of Object.entries(bindings)) {
          if (uid !== userId && username in userBindings) return session.send(`用户名 ${username} 已被其他用户绑定到服务器 #${userBindings[username]}`)
        }
        // 检查是否已绑定同一服务器的相同用户名
        if (bindings[userId]?.hasOwnProperty(username) && bindings[userId][username] === serverId) return session.send(`已绑定用户名 ${username} 到服务器 #${serverId}`)
        try {
          await executeRconCommand(`whitelist add ${username}`, serverInfo.rconConfig, session)
          if (!bindings[userId]) {
            bindings[userId] = { [username]: serverId }
          } else {
            bindings[userId][username] = serverId
          }
          await fileManager.saveWhitelistBindings(bindings)
          return session.send(`已绑定用户名 ${username} 到服务器 #${serverId}`)
        } catch (error) {
          return session.send(`白名单添加失败，未绑定: ${error.message} [#${serverId}]`)
        }
      })
  }
}