import { Context, Session } from 'koishi';
import { Config } from '../index';
import { FileManager } from '../utils/fileManager';
import { Rcon } from 'rcon-client';

/**
 * RCON服务器配置接口
 * @interface ServerConfig
 * @property {number} id - 服务器唯一标识
 * @property {string} rconAddress - RCON地址，格式为"host:port"
 * @property {string} rconPassword - RCON密码
 */
export interface ServerConfig {
  id: number;
  rconAddress: string;
  rconPassword: string;
}

/**
 * 执行RCON命令的核心函数。
 * 它负责连接、发送命令、关闭连接，并返回结果或在失败时抛出异常。
 * @param command 要执行的命令
 * @param serverConfig 目标服务器的RCON配置
 * @returns 返回命令执行结果的字符串
 */
async function executeRconCommand(command: string, serverConfig: ServerConfig): Promise<string> {
  const [host, portStr] = (serverConfig.rconAddress || '').split(':');
  const port = parseInt(portStr || '');

  if (!serverConfig.rconPassword || !host || !portStr || isNaN(port)) {
    throw new Error(`服务器 #${serverConfig.id} RCON 配置错误`);
  }

  const rcon = await Rcon.connect({ host, port, password: serverConfig.rconPassword });
  try {
    const result = await rcon.send(command);
    return result;
  } finally {
    await rcon.end();
  }
}

/**
 * 查找服务器配置
 * @param config 插件总配置
 * @param serverId 服务器ID
 * @returns 返回包含服务器信息的对象
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
 * 在执行服务器命令前，自动确定目标服务器ID的通用逻辑。
 * 如果无法确定服务器，则返回错误消息字符串，中断命令执行。
 * @returns {string|undefined} 如果有错误则返回错误消息，否则返回undefined。
 */
function setupServerIdBefore({ session, options }: { session?: Session; options?: any }, config: Config): string | undefined {
  if (!session) return '';

  if (!options.server) {
    const mapping = config.serverMaps.find(m => m.platform === session.platform && m.channelId === session.guildId);
    if (!mapping) {
      return '该群组未配置对应服务器';
    }
    options.server = mapping.serverId;
  }
}

/**
 * 注册所有与服务器管理相关的命令。
 */
export function registerServer(ctx: Context, parent: any, config: Config) {
  const server = parent.subcommand('.server', '管理 Minecraft 服务器')
    .usage('mc.server - 向 Minecraft 服务器内发送消息和执行命令');

  // .say 命令
  server.subcommand('.say <message:text>', '发送聊天消息')
    .usage('mc.server.say <消息内容> - 发送消息到 Minecraft 服务器')
    .option('server', '-s <serverId:number> 指定服务器 ID')
    .before((argv) => setupServerIdBefore(argv, config))
    .action(async ({ session, options }, message) => {
      if (!session) return;
      if (!message) return '请输入要发送的消息';

      const serverId = options.server as number;
      const serverInfo = findServer(config, serverId);

      if (!serverInfo.found) return `未找到服务器 #${serverId}`;
      if (!serverInfo.rconConfig) return `服务器 #${serverId} 未配置 RCON`;

      const sender = session.username || session.userId;
      const command = `say ${sender}: ${message}`;

      try {
        await executeRconCommand(command, serverInfo.rconConfig);
        return `已执行命令 [#${serverId}]`;
      } catch (error) {
        return `命令执行失败 [#${serverId}] - ${error.message}`;
      }
    });

  // .run 命令
  server.subcommand('.run <command:text>', '执行命令')
    .usage('mc.server.run <命令内容> - 执行指定 Minecraft 命令')
    .option('server', '-s <serverId:number> 指定服务器 ID')
    .before((argv) => setupServerIdBefore(argv, config))
    .action(async ({ session, options }, command) => {
      if (!session) return;
      if (!command) return '请输入要执行的命令';

      const serverId = options.server as number;
      const serverInfo = findServer(config, serverId);

      if (!serverInfo.found) return `未找到服务器 #${serverId}`;
      if (!serverInfo.rconConfig) return `服务器 #${serverId} 未配置 RCON`;

      try {
        const result = await executeRconCommand(command, serverInfo.rconConfig);
        return result ? `已执行命令 [#${serverId}]\n${result}` : `已执行命令 [#${serverId}]`;
      } catch (error) {
        return `命令执行失败 [#${serverId}] - ${error.message}`;
      }
    });

  // .bind 白名单命令
  if (config.bindEnabled) {
    const fileManager = new FileManager(ctx);
    server.subcommand('.bind [username:string]', '白名单管理')
      .usage('mc.server.bind [用户名] - 绑定或解绑 Minecraft 用户名')
      .option('server', '-s <serverId:number> 指定服务器 ID')
      .option('remove', '-r 解绑指定用户名')
      .action(async ({ session, options }, username) => {
        if (!session || !session.userId) return;

        const bindings = await fileManager.getWhitelistBindings();
        const userId = session.userId;

        // 1. 显示当前用户的绑定列表
        if (!username) {
          const userBindings = bindings[userId];
          if (!userBindings || Object.keys(userBindings).length === 0) return '未绑定任何用户名';
          const bindingList = Object.entries(userBindings)
            .map(([name, serverId]) => `${name} → 服务器#${serverId}`).join('\n');
          return `已绑定的用户名：\n${bindingList}`;
        }

        const serverId = options.server || config.serverMaps.find(m => m.platform === session.platform && m.channelId === session.channelId)?.serverId;

        // 2. 解绑模式
        if (options.remove) {
          if (!bindings[userId]?.[username]) return `未找到绑定用户名 ${username}`;

          const boundServerId = bindings[userId][username];
          const serverInfo = findServer(config, boundServerId);
          if (!serverInfo.found || !serverInfo.rconConfig) return `服务器 #${boundServerId} 不存在或未配置RCON`;

          try {
            await executeRconCommand(`whitelist remove ${username}`, serverInfo.rconConfig);
            delete bindings[userId][username];
            if (Object.keys(bindings[userId]).length === 0) delete bindings[userId];
            await fileManager.saveWhitelistBindings(bindings);
            return `已解绑用户名 ${username} [#${boundServerId}]`;
          } catch (error) {
            ctx.logger.warn(`白名单移除失败: ${error.message} [#${boundServerId}]`);
            return `白名单移除失败，未解除绑定: ${error.message} [#${boundServerId}]`;
          }
        }

        // 3. 绑定模式
        if (username.length < 3 || username.length > 16) return '无效的用户名';
        if (!serverId) return '该群组未配置对应服务器';

        const serverInfo = findServer(config, serverId);
        if (!serverInfo.found) return `未找到服务器 #${serverId}`;
        if (!serverInfo.rconConfig) return `服务器 #${serverId} 未配置 RCON`;

        for (const [uid, userBindings] of Object.entries(bindings)) {
          if (uid !== userId && username in userBindings) {
            return `用户名 ${username} 已被其他用户绑定到服务器 #${userBindings[username]}`;
          }
        }
        if (bindings[userId]?.[username] === serverId) return `已绑定用户名 ${username} 到服务器 #${serverId}`;

        try {
          await executeRconCommand(`whitelist add ${username}`, serverInfo.rconConfig);
          if (!bindings[userId]) bindings[userId] = {};
          bindings[userId][username] = serverId;
          await fileManager.saveWhitelistBindings(bindings);
          return `已绑定用户名 ${username} 到服务器 #${serverId}`;
        } catch (error) {
          return `白名单添加失败，未绑定: ${error.message} [#${serverId}]`;
        }
      });
  }
}
