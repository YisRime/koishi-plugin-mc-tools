import { Context, Command } from 'koishi'
import { Config } from '../index'

/**
 * 更新目标配置
 * @interface UpdTarget
 * @property {string} platform - 机器人平台名称
 * @property {string} channelId - 频道/群组ID
 * @property {'release' | 'snapshot' | 'both'} type - 通知类型：正式版、快照版或两者都通知
 */
export interface UpdTarget {
  platform: string
  channelId: string
  type: 'release' | 'snapshot' | 'both'
}

/**
 * 群组到服务器的映射配置
 * @interface ServerMaps
 * @property {string} platform - 平台ID
 * @property {string} channelId - 频道ID
 * @property {number} serverId - 对应的服务器ID
 * @property {string} [serverAddress] - 用于服务器查询的地址(可选)
 */
export interface ServerMaps {
  platform: string
  channelId: string
  serverId: number
  serverAddress?: string
}

/**
 * Minecraft版本清单API数据结构
 * @interface MinecraftVersion
 */
interface MinecraftVersion {
  latest: { release: string; snapshot: string }
  versions: Array<{
    id: string
    type: string
    url: string
    time: string
    releaseTime: string
  }>
}

/**
 * 版本信息类型
 * @typedef {Object} VersionInfo
 * @property {string} id - 版本ID
 * @property {string} releaseTime - 版本发布时间
 */
type VersionInfo = { id: string; releaseTime: string }

/**
 * 版本类型
 * @typedef {'release' | 'snapshot'} VersionType
 */
type VersionType = 'release' | 'snapshot'

/**
 * 获取最新的Minecraft版本信息
 * @param {Context} ctx - Koishi上下文
 * @returns {Promise<{release: VersionInfo, snapshot: VersionInfo}>} 最新版本信息
 */
async function getLatestVersion(): Promise<{ release: VersionInfo; snapshot: VersionInfo }> {
  const apiUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`API 响应错误: ${response.status}`);
  const { latest, versions } = await response.json() as MinecraftVersion;
  const release = versions.find(v => v.id === latest.release);
  const snapshot = versions.find(v => v.id === latest.snapshot);
  return {
    release: { id: release.id, releaseTime: release.releaseTime },
    snapshot: { id: snapshot.id, releaseTime: snapshot.releaseTime }
  };
}

/**
 * 向指定目标发送更新通知
 */
async function sendUpdateNotification(ctx: Context, targets: UpdTarget[], versionType: VersionType, versionInfo: VersionInfo) {
  const typeName = versionType === 'release' ? '正式版' : '快照版';
  const updateMsg = `Minecraft ${typeName}更新：${versionInfo.id}\n发布时间: ${new Date(versionInfo.releaseTime).toLocaleString('zh-CN')}`;
  const filteredTargets = targets.filter(t => t.type === 'both' || t.type === versionType);

  for (let i = 0; i < filteredTargets.length; i++) {
    const target = filteredTargets[i];
    const bot = ctx.bots.find(bot => bot.platform === target.platform);
    if (bot) {
      await bot.sendMessage(target.channelId, updateMsg);
      if (i < filteredTargets.length - 1) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// 存储最新版本和检查定时器
const prevVersions = { release: { id: '', releaseTime: '' }, snapshot: { id: '', releaseTime: '' } };
let versionCheckInterval: any = null;

/**
 * 清理版本检查定时器
 */
export function cleanupVerCheck() {
  if (versionCheckInterval) {
    clearInterval(versionCheckInterval);
    versionCheckInterval = null;
  }
}

/**
 * 注册Minecraft版本查询命令
 */
export function registerVer(mc: Command) {
  mc.subcommand('.ver', '查询 Minecraft 最新版本')
    .action(async () => {
      const formatVersionInfo = (release, snapshot) => {
        const formatDate = date => new Date(date).toLocaleDateString('zh-CN');
        return `Minecraft 最新版本：\n正式版: ${release.id}(${formatDate(release.releaseTime)})\n快照版: ${snapshot.id}(${formatDate(snapshot.releaseTime)})`;
      };
      try {
        const versions = await getLatestVersion();
        return formatVersionInfo(versions.release, versions.snapshot);
      } catch (error) {
        if (prevVersions.release.id && prevVersions.snapshot.id) return formatVersionInfo(prevVersions.release, prevVersions.snapshot);
        return '获取 Minecraft 版本信息失败';
      }
    });
}

/**
 * 设置Minecraft版本更新检测和通知
 */
export function regVerCheck(ctx: Context, config: Config) {
  const checkVersions = async () => {
    try {
      const latest = await getLatestVersion();
      const isFirstCheck = !prevVersions.release.id;
      // 检查并推送更新
      if (!isFirstCheck) {
        ['release', 'snapshot'].forEach(type => {
          if (latest[type].id !== prevVersions[type].id) sendUpdateNotification(ctx, config.noticeTargets, type as VersionType, latest[type]);
        });
      }
      Object.assign(prevVersions, latest);
    } catch (error) {
      ctx.logger.warn('获取版本信息失败:', error);
    }
  };

  // 初始化并设置定时任务
  checkVersions();
  versionCheckInterval = ctx.setInterval(checkVersions, config.updInterval * 60000);
}
