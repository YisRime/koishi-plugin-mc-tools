import { Context, Session } from 'koishi'
import { Config } from '../index'
import { FileManager } from '../utils/fileManager'
import { Rcon } from 'rcon-client'

/**
 * RCON服务器配置接口
 * @interface ServerConfig
 * @property {number} id - 服务器唯一标识
 * @property {string} rconAddress - RCON地址，格式为"host:port"
 * @property {string} rconPassword - RCON密码
 */
export interface ServerConfig { id: number, rconAddress: string, rconPassword: string }

/**
 * 执行RCON命令
 */
async function executeRconCommand(command: string, serverConfig: ServerConfig, session: Session): Promise<void> {
  if (!command) {
    session.send('请输入要执行的命令');
    return;
  }
  const [serverHost, portStr] = (serverConfig.rconAddress || '').split(':');
  const port = parseInt(portStr || '');
  if (!serverConfig.rconPassword || !serverHost || !portStr || isNaN(port)) {
    session.send(`服务器 #${serverConfig.id} RCON 配置错误`);
    return;
  }
  try {
    const rcon = await Rcon.connect({host: serverHost, port, password: serverConfig.rconPassword});
    const result = await rcon.send(command);
    await rcon.end();
    await session.send(result ? `已执行命令 [#${serverConfig.id}]\n${result}` : `已执行命令 [#${serverConfig.id}]`);
  } catch (error) {
    await session.send(`命令执行失败 [#${serverConfig.id}] - ${error.message}`);
  }
}

/**
 * 查找服务器配置
 */
function findServer(config: Config, serverId: number) {
  const rconServer = config.rconServers.find(s => s.id === serverId);
  return {
    found: !!rconServer,
    id: serverId,
    displayName: `服务器 #${serverId}`,
    rconConfig: rconServer || null
  };
}

/**
 * 处理服务器命令前的通用逻辑
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
 * 注册服务器相关命令
 */
export function registerServer(ctx: Context, parent: any, config: Config) {
  const server = parent.subcommand('.server', '管理 Minecraft 服务器')
    .usage('mc.server - 向 Minecraft 服务器内发送消息和执行命令');

  server.subcommand('.say <message:text>', '发送聊天消息')
    .usage('mc.server.say <消息内容> - 发送消息到 Minecraft 服务器')
    .option('server', '-s <serverId:number> 指定服务器 ID')
    .before(ctx => setupServerIdBefore(ctx, config))
    .action(async ({ session, options }, message) => {
      if (!message) return session.send('请输入要发送的消息');
      const serverId = options.server as number;
      const serverInfo = findServer(config, serverId);
      if (!serverInfo.found) return session.send(`未找到服务器 #${serverId}`);
      if (!serverInfo.rconConfig) return session.send(`服务器 #${serverId} 未配置 RCON`);
      const sender = session.username || session.userId;
      await executeRconCommand(`say ${sender}: ${message}`, serverInfo.rconConfig, session);
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
