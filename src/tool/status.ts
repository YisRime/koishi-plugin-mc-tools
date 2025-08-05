import { Context, Command } from 'koishi'
import { Config } from '../index'

/**
 * 定义了机器人发送通知的目标。
 */
export interface StatusTarget {
  platform: string;
  channelId: string;
}

/**
 * 定义了 Minecraft 服务状态的数据结构。
 * 键是服务名称，值是服务的健康状态。
 */
interface MinecraftStatus {
  [service: string]: 'green' | 'yellow' | 'red';
}

/**
 * 描述一次具体服务状态变更的详细信息。
 */
interface StatusChange {
  service: string;
  from: 'green' | 'yellow' | 'red';
  to: 'green' | 'yellow' | 'red';
}

/** 需要监控的 Minecraft 服务列表 */
const servicesToCheck = {
  'Minecraft.net': 'https://minecraft.net/',
  'Session Minecraft': 'http://session.minecraft.net/',
  'Account Mojang': 'http://account.mojang.com/',
  'Auth Mojang': 'https://auth.mojang.com/',
  'Skins Minecraft': 'http://skins.minecraft.net/',
  'Authserver Mojang': 'https://authserver.mojang.com/',
  'Sessionserver Mojang': 'https://sessionserver.mojang.com/',
  'API Mojang': 'https://api.mojang.com/',
  'Textures Minecraft': 'http://textures.minecraft.net/',
};

/** 状态到表情符号的映射 */
const emojiMap = { green: '✅', yellow: '⚠️', red: '❌' };

/**
 * 将 Minecraft 状态对象格式化为用户友好的、带表情符号的字符串。
 * @param status - 要格式化的状态对象。
 * @returns 格式化后的消息字符串。
 */
function formatStatusMessage(status: MinecraftStatus): string {
  const statusLines = Object.entries(status).map(([service, state]) => {
    return `${emojiMap[state]} ${service}`;
  });
  return ['Minecraft 服务状态:', ...statusLines].join('\n');
}

/**
 * 检查单个服务的在线状态和延迟。
 * @param url - 要检查的服务 URL。
 * @param timeoutMs - 请求超时时间（毫秒），默认为 15000。
 * @returns 服务的健康状态 ('green', 'yellow', 'red')。
 */
async function checkServiceStatus(url: string, timeoutMs = 15000): Promise<'green' | 'yellow' | 'red'> {
  const startTime = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const duration = Date.now() - startTime;
    return response.status < 500 ? (duration > 5000 ? 'yellow' : 'green') : 'red';
  } catch (error) {
    return 'red';
  }
}

/**
 * 并发检查所有预定义的服务，并返回它们的状态集合。
 * @returns 包含所有服务状态的对象。
 */
async function getMinecraftStatus(): Promise<MinecraftStatus> {
  const statusEntries = await Promise.all(
    Object.entries(servicesToCheck).map(async ([name, url]) => {
      const status = await checkServiceStatus(url);
      return [name, status] as const;
    })
  );
  return Object.fromEntries(statusEntries);
}

/**
 * 将多个状态变更合并为一条通知，并通过 ctx.broadcast 发送出去。
 * @param ctx - Koishi 的上下文对象。
 * @param targets - 通知的目标频道列表。
 * @param changes - 本次检查中发生的状态变更列表。
 */
async function sendStatusNotification(ctx: Context, targets: StatusTarget[], changes: StatusChange[]) {
  if (!targets?.length) return;

  const statusToText = (status: string) => ({ green: '恢复正常', yellow: '响应缓慢', red: '服务异常' })[status];

  const changeLines = changes.map(({ service, to }) => `${emojiMap[to]} ${service}: ${statusToText(to)}`);
  const statusMessage = ['Minecraft 服务状态变更:', ...changeLines].join('\n');

  const broadcastChannels = targets.map(t => `${t.platform}:${t.channelId}`);
  await ctx.broadcast(broadcastChannels, statusMessage);
}

let prevStatus: MinecraftStatus = {};
let statusCheckInterval: (() => void) | null = null;

/**
 * 清理并停止后台的状态检查定时器。应在插件停用时调用。
 */
export function cleanupStatusCheck() {
  if (statusCheckInterval) {
    statusCheckInterval();
    statusCheckInterval = null;
  }
}

/**
 * 向 Koishi 注册 .status 子命令，用于查询服务状态。
 * @param mc - 父命令 'mc' 的实例。
 */
export function registerStatus(mc: Command) {
  mc.subcommand('.status', '查询 Minecraft 服务状态')
    .action(async ({ session }) => {
      try {
        session.send('正在获取 Minecraft 服务状态，请稍候...');
        const currentStatus = await getMinecraftStatus();
        return formatStatusMessage(currentStatus);
      } catch (error) {
        return '获取 Minecraft 服务状态失败';
      }
    });
}

/**
 * 设置并启动后台的定时状态检查任务。如果检测到状态变更，则发送通知。
 * @param ctx - Koishi 的上下文对象。
 * @param config - 插件的配置对象，包含通知目标和检查间隔。
 */
export function regStatusCheck(ctx: Context, config: Config & { statusNoticeTargets?: StatusTarget[], statusUpdInterval?: number }) {
  const checkStatus = async () => {
    try {
      const currentStatus = await getMinecraftStatus();
      if (Object.keys(prevStatus).length > 0) {
        const changes: StatusChange[] = Object.entries(currentStatus)
          .filter(([service, to]) => prevStatus[service] && prevStatus[service] !== to)
          .map(([service, to]) => ({ service, from: prevStatus[service], to }));

        if (changes.length > 0) {
          sendStatusNotification(ctx, config.statusNoticeTargets, changes);
        }
      }
      prevStatus = currentStatus;
    } catch (error) {
      ctx.logger.warn('获取Minecraft服务状态失败:', error);
    }
  };

  if (config.statusNoticeTargets?.length) {
    checkStatus();
    statusCheckInterval = ctx.setInterval(checkStatus, (config.statusUpdInterval ?? 10) * 60000);
  }
}
