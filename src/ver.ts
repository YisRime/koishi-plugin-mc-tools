import { Context, Logger } from 'koishi'
import axios from 'axios'
import { MTConfig } from './index'

const logger = new Logger('mcver')

interface NotificationTarget {
  platform: string
  type: 'private' | 'guild'
  id: string
}

const VERSION_API_SOURCES = {
  MOJANG: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  BMCLAPI: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json',
}

/**
 * 获取 Minecraft 版本信息
 */
export async function fetchVersions(timeout = 10000) {
  for (const apiUrl of Object.values(VERSION_API_SOURCES)) {
    try {
      const { data } = await axios.get(apiUrl, { timeout })
      const latest = data.versions[0]
      const release = data.versions.find(v => v.type === 'release')
      if (!latest || !release) throw new Error('版本数据解析失败')
      return { latest, release, versions: data.versions }
    } catch (error) {
      logger.warn(`API 源 ${apiUrl} 请求失败:`, error.message || String(error))
    }
  }
  throw new Error('所有 API 源均请求失败')
}

/**
 * 获取格式化的 Minecraft 版本信息
 */
export async function getFormattedVersionInfo() {
  try {
    const { latest, release } = await fetchVersions()
    const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN')
    return {
      success: true,
      data: `Minecraft 最新版本：\n正式版: ${release.id}(${formatDate(release.releaseTime)})\n快照版: ${latest.id}(${formatDate(latest.releaseTime)})`
    }
  } catch (error) {
    return {
      success: false,
      error: `版本信息获取失败：${error.message || String(error)}`
    }
  }
}

/**
 * 解析通知目标
 */
function parseNotificationTarget(target: string): NotificationTarget | null {
  const parts = target.split(':')
  if (parts.length === 2) {
    const [platform, id] = parts
    return { platform, type: 'guild', id }
  } else if (parts.length === 3) {
    const [platform, type, id] = parts
    if (!['private', 'guild'].includes(type)) return null
    return { platform, type: type as 'private' | 'guild', id }
  }
  return null
}

/**
 * 发送版本更新通知
 */
async function sendVersionUpdateNotification(ctx: Context, targets: string[], updateMessage: string) {
  for (const target of targets) {
    const parsed = parseNotificationTarget(target)
    if (!parsed) {
      logger.warn(`通知目标无效: ${target}`)
      continue
    }
    try {
      const bot = ctx.bots[`${parsed.platform}:${parsed.id}`]
      if (!bot) continue
      if (parsed.type === 'private') {
        await bot.sendPrivateMessage(parsed.id, updateMessage)
      } else {
        await bot.sendMessage(parsed.id, updateMessage)
      }
    } catch (e) {
      logger.warn(`通知发送失败|${parsed.platform}:${parsed.type}:${parsed.id}: `, e)
    }
  }
}

/**
 * 检查 Minecraft 版本更新
 */
export async function checkMinecraftVersions(versionState: { snapshot: string, release: string }, ctx: Context, config: MTConfig) {
  try {
    const { latest, release } = await fetchVersions()
    // 检查快照版更新
    if (config.snapshot && versionState.snapshot && latest.id !== versionState.snapshot) {
      const updateMsg = `Minecraft 快照版更新：${latest.id}\n发布时间: ${new Date(latest.releaseTime).toLocaleString('zh-CN')}`
      await sendVersionUpdateNotification(ctx, config.guilds, updateMsg)
    }
    versionState.snapshot = latest.id
    // 检查正式版更新
    if (config.release && versionState.release && release.id !== versionState.release) {
      const updateMsg = `Minecraft 正式版更新：${release.id}\n发布时间: ${new Date(release.releaseTime).toLocaleString('zh-CN')}`
      await sendVersionUpdateNotification(ctx, config.guilds, updateMsg)
    }
    versionState.release = release.id
  } catch (error) {
    logger.warn('版本检查失败：', error)
  }
}

/**
 * 注册版本相关命令
 */
export function registerVersion(ctx: Context, parent: any, config: MTConfig): NodeJS.Timeout | undefined {
  const versionState = { snapshot: '', release: '' }

  parent.subcommand('.ver', '查询 Minecraft 版本信息')
    .action(async () => {
      const result = await getFormattedVersionInfo()
      return result.success ? result.data : result.error
    })

  // 版本更新检查
  if (config.verCheck && config.guilds.length) {
    checkMinecraftVersions(versionState, ctx, config)
    return setInterval(() => checkMinecraftVersions(versionState, ctx, config), config.interval * 60 * 1000)
  }
}
