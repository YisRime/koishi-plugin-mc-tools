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
 * Minecraft版本清单API地址列表
 * @constant {string[]}
 */
const VERSION_APIS = [
  'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json'
];

/**
 * 获取最新的Minecraft版本信息
 * @param {Context} ctx - Koishi上下文
 * @returns {Promise<{release: VersionInfo, snapshot: VersionInfo}>} 最新的正式版和快照版本信息
 * @throws {Error} 当所有API源都无法获取版本信息时抛出错误
 */
async function getLatestVersion(ctx: Context): Promise<{ release: VersionInfo; snapshot: VersionInfo }> {
  for (const apiUrl of VERSION_APIS) {
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) continue;
      const { latest, versions } = await response.json() as MinecraftVersion;
      const release = versions.find(v => v.id === latest.release);
      const snapshot = versions.find(v => v.id === latest.snapshot);
      return {
        release: { id: release.id, releaseTime: release.releaseTime },
        snapshot: { id: snapshot.id, releaseTime: snapshot.releaseTime }
      };
    } catch (error) {
      ctx.logger.warn('获取 Minecraft 版本信息失败:', error);
    }
  }
  throw new Error('获取 Minecraft 版本信息失败');
}

/**
 * 向指定目标发送更新通知
 * @param {Context} ctx - Koishi上下文
 * @param {UpdTarget[]} targets - 通知目标列表
 * @param {VersionType} versionType - 版本类型（正式版或快照版）
 * @param {VersionInfo} versionInfo - 版本信息
 * @returns {Promise<void>}
 */
async function sendUpdateNotification(ctx: Context, targets: UpdTarget[], versionType: VersionType, versionInfo: VersionInfo) {
  const typeName = versionType === 'release' ? '正式版' : '快照版'
  const updateMsg = `Minecraft ${typeName}更新：${versionInfo.id}\n发布时间: ${new Date(versionInfo.releaseTime).toLocaleString('zh-CN')}`
  for (const target of targets.filter(t => t.type === 'both' || t.type === versionType)) {
    const bot = ctx.bots.find(bot => bot.platform === target.platform)
    if (!bot) continue;
    try {
      await bot.sendMessage(target.channelId, updateMsg)
    } catch (err) {
      ctx.logger.error(`发送更新通知失败 [${target.platform}:${target.channelId}]:`, err)
    }
  }
}

/**
 * 注册Minecraft版本查询命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令实例
 * @returns {void}
 */
export function registerVer(ctx: Context, mc: Command) {
  mc.subcommand('.ver', '查询 Minecraft 最新版本')
    .action(async () => {
      try {
        const { release, snapshot } = await getLatestVersion(ctx)
        const formatDate = date => new Date(date).toLocaleDateString('zh-CN')
        return `Minecraft 最新版本：\n正式版: ${release.id}(${formatDate(release.releaseTime)})\n快照版: ${snapshot.id}(${formatDate(snapshot.releaseTime)})`
      } catch (error) {
        return '获取 Minecraft 版本信息失败'
      }
    })
}

// 存储版本检查定时器
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
 * 设置Minecraft版本更新检测和通知
 * @param {Context} ctx - Koishi上下文
 * @param {Config} config - 配置参数
 * @returns {void}
 */
export function regVerCheck(ctx: Context, config: Config) {
  let prevVersions = { release: '', snapshot: '' }
  const checkVersions = async () => {
    try {
      const latest = await getLatestVersion(ctx)
      if (!prevVersions.release) {
        prevVersions.release = latest.release.id
        prevVersions.snapshot = latest.snapshot.id
        return
      }
      // 检查并推送更新
      for (const type of ['release', 'snapshot'] as const) {
        if (latest[type].id !== prevVersions[type]) {
          await sendUpdateNotification(ctx, config.noticeTargets, type, latest[type])
          prevVersions[type] = latest[type].id
        }
      }
    } catch (error) {
    }
  }
  // 初始化并设置定时任务
  checkVersions()
  const interval = (config.updInterval) * 60 * 1000
  versionCheckInterval = ctx.setInterval(checkVersions, interval)
}
