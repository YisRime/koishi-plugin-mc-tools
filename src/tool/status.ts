import { Context, Command } from 'koishi';
import { Config } from '../index';

/**
 * 定义机器人发送通知的目标。
 */
export interface StatusTarget {
  platform: string;
  channelId: string;
}

/**
 * 定义了 Minecraft 服务状态的数据结构。
 * 'green' 代表正常, 'red' 代表异常。
 */
type MinecraftStatus = Record<string, 'green' | 'red'>;

/**
 * 描述一次具体服务状态变更的详细信息。
 */
interface StatusChange {
  service: string;
  from: 'green' | 'red';
  to: 'green' | 'red';
}

/** 需要监控的 Minecraft 服务列表 */
const servicesToCheck = {
  'Minecraft.net': 'https://minecraft.net/',
  'Textures': 'http://textures.minecraft.net/',
  'Session': 'http://session.minecraft.net/',
  'Mojang API': 'https://api.mojang.com/',
  'Mojang Account': 'http://account.mojang.com/',
  'Mojang Sessionserver': 'https://sessionserver.mojang.com/',
};

/**
 * 将 Minecraft 状态对象格式化为用户友好的字符串。
 * @param status - 要格式化的状态对象。
 * @returns 格式化后的消息字符串。
 */
function formatStatusMessage(status: MinecraftStatus): string {
  const statusLines = Object.entries(status).map(([service, state]) => {
    const symbol = state === 'green' ? '[√]' : '[×]';
    return `${symbol} ${service}`;
  });
  return ['Minecraft 服务状态:', ...statusLines].join('\n');
}

/**
 * 检查单个服务的在线状态。
 * @param url - 要检查的服务 URL。
 * @returns 服务的健康状态 ('green' | 'red')。
 */
async function checkServiceStatus(url: string): Promise<'green' | 'red'> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    return response.status < 500 ? 'green' : 'red';
  } catch {
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

  const changeLines = changes.map(({ service, to }) => {
    const symbol = to === 'green' ? '[√]' : '[×]';
    const statusText = to === 'green' ? '恢复正常' : '服务异常';
    return `${symbol} ${service}: ${statusText}`;
  });

  const statusMessage = ['Minecraft 服务状态变更:', ...changeLines].join('\n');
  const broadcastChannels = targets.map(t => `${t.platform}:${t.channelId}`);
  await ctx.broadcast(broadcastChannels, statusMessage);
}

let prevStatus: MinecraftStatus = {};
let statusCheckInterval: NodeJS.Timeout | null = null;

/**
 * 清理并停止后台的状态检查定时器。
 */
export function cleanupStatusCheck() {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
}

/**
 * 向 Koishi 注册 .status 子命令。
 * @param mc - 父命令 'mc' 的实例。
 */
export function registerStatus(mc: Command) {
  mc.subcommand('.status', '查询 Minecraft 服务状态')
    .action(async ({ session }) => {
      try {
        await session.send('正在获取 Minecraft 服务状态，请稍候...');
        const currentStatus = await getMinecraftStatus();
        return formatStatusMessage(currentStatus);
      } catch (error) {
        return '获取 Minecraft 服务状态失败';
      }
    });
}

/**
 * 设置并启动后台的定时状态检查任务。
 * @param ctx - Koishi 的上下文对象。
 * @param config - 插件的配置对象。
 */
export function regStatusCheck(ctx: Context, config: Config & { statusNoticeTargets?: StatusTarget[], statusUpdInterval?: number }) {
  if (!config.statusNoticeTargets?.length) return;

  const checkStatus = async () => {
    try {
      const currentStatus = await getMinecraftStatus();
      if (Object.keys(prevStatus).length > 0) {
        const changes: StatusChange[] = Object.entries(currentStatus)
          .filter(([service, to]) => prevStatus[service] && prevStatus[service] !== to)
          .map(([service, to]) => ({ service, from: prevStatus[service], to }));

        if (changes.length > 0) {
          await sendStatusNotification(ctx, config.statusNoticeTargets, changes);
        }
      }
      prevStatus = currentStatus;
    } catch (error) {
      ctx.logger.warn('获取 Minecraft 服务状态失败:', error);
    }
  };

  // 启动时立即执行一次，然后设置定时器
  checkStatus();
  const intervalMinutes = config.statusUpdInterval ?? 10;
  statusCheckInterval = setInterval(checkStatus, intervalMinutes * 60 * 1000);
}
