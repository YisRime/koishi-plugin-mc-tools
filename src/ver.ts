import { Context, Logger } from 'koishi'
import axios from 'axios'
import { MinecraftToolsConfig } from './index'
import { promises as fs } from 'fs'
import path from 'path'

const logger = new Logger('mcver')

const API_SOURCES = {
  MOJANG: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  BMCLAPI: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json',
}

/**
 * 获取 Minecraft 版本信息
 * @param {number} timeout - 请求超时时间(毫秒)
 * @returns {Promise<{latest: MinecraftVersionInfo, release: MinecraftVersionInfo, versions: MinecraftVersionInfo[]}>}
 * @throws {Error} 当所有 API 源都请求失败时抛出错误
 */
async function fetchVersions(timeout = 10000) {
  const apiSources = Object.values(API_SOURCES)
  let lastError = null

  for (const apiUrl of apiSources) {
    try {
      const { data } = await axios.get(apiUrl, { timeout })

      const latest = data.versions[0]
      const release = data.versions.find(v => v.type === 'release')

      if (!latest || !release) {
        throw new Error('版本数据解析失败')
      }

      return { latest, release, versions: data.versions }
    } catch (error) {
      lastError = error
      logger.warn(`API 源 ${apiUrl} 请求失败:`, error.message || String(error))
      continue
    }
  }

  throw new Error(`所有 API 源均请求失败: ${lastError?.message || String(lastError)}`)
}

/**
 * 获取格式化的 Minecraft 版本信息
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
async function getVersionInfo() {
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
 * 解析通知目标配置
 * @param target 格式: "platform:type:id"
 */
interface ParsedTarget {
  platform: string
  type: 'private' | 'group'
  id: string
}

function parseTarget(target: string): ParsedTarget | null {
  const parts = target.split(':')
  if (parts.length !== 3) return null

  const [platform, type, id] = parts
  if (!['private', 'group'].includes(type)) return null

  return { platform, type: type as 'private' | 'group', id }
}

/**
 * 向目标发送版本更新通知
 * @param {Context} ctx - Koishi 上下文
 * @param {string[]} targets - 目标配置列表 (格式: platform:type:id)
 * @param {string} updateMessage - 更新消息内容
 * @private
 */
async function notifyVersionUpdate(ctx: any, targets: string[], updateMessage: string) {
  for (const target of targets) {
    const parsed = parseTarget(target)
    if (!parsed) {
      logger.warn(`无效的通知目标配置: ${target}`)
      continue
    }

    for (const bot of ctx.bots) {
      if (bot.platform !== parsed.platform) continue

      try {
        if (parsed.type === 'private') {
          await bot.sendPrivateMessage(parsed.id, updateMessage)
        } else {
          await bot.sendMessage(parsed.id, updateMessage)
        }
      } catch (e) {
        logger.warn(`通知发送失败|${parsed.type} ${parsed.id}:`, e)
      }
    }
  }
}

/**
 * 获取版本信息存储文件的路径
 * @param ctx Koishi 上下文
 * @returns 文件路径
 */
async function getVersionFilePath(ctx: Context): Promise<string> {
  const dataDir = path.join(ctx.baseDir, 'data')
  return path.join(dataDir, 'mcver-latest.json')
}

/**
 * 从文件读取版本信息
 * @param ctx Koishi 上下文
 * @returns 版本信息对象
 */
async function readVersionsFromFile(ctx: Context): Promise<{ snapshot: string, release: string }> {
  const filePath = await getVersionFilePath(ctx)
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    logger.info('读取版本信息失败:', err.message)
    return { snapshot: '', release: '' }
  }
}

/**
 * 将版本信息保存到文件
 * @param ctx Koishi 上下文
 * @param versions 版本信息对象
 */
async function saveVersionsToFile(ctx: Context, versions: { snapshot: string, release: string }): Promise<void> {
  const filePath = await getVersionFilePath(ctx)
  try {
    await fs.writeFile(filePath, JSON.stringify(versions, null, 2), 'utf-8')
  } catch (err) {
    logger.warn('保存版本信息失败:', err)
  }
}

/**
 * 检查 Minecraft 版本更新并发送通知
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
async function checkUpdate(ctx: Context, config: MinecraftToolsConfig) {
  try {
    // 从文件读取当前版本信息
    const versions = await readVersionsFromFile(ctx)

    const { latest, release } = await fetchVersions()
    const updates = [
      { type: 'snapshot', version: latest, enabled: config.ver.snapshot },
      { type: 'release', version: release, enabled: config.ver.release }
    ]

    let versionsChanged = false

    for (const { type, version, enabled } of updates) {
      if (versions[type] && version.id !== versions[type] && enabled) {
        const msg = `Minecraft ${type === 'release' ? '正式版' : '快照版'}更新：${version.id}\n发布时间: ${new Date(version.releaseTime).toLocaleString('zh-CN')}`
        await notifyVersionUpdate(ctx, config.ver.groups, msg)
        versionsChanged = true
      }
      versions[type] = version.id
    }

    // 如果版本有变化，保存到文件
    if (versionsChanged) {
      await saveVersionsToFile(ctx, versions)
    }
  } catch (error) {
    logger.warn('版本检查失败：', error)
  }
}

/**
 * 注册 Minecraft 版本相关命令
 * @param {Context} ctx - Koishi 上下文
 * @param {Command} parent - 父命令
 * @param {MinecraftToolsConfig} config - 插件配置
 * @returns {NodeJS.Timeout|undefined} - 如果启用了定时检查，返回定时器句柄
 */
export function registerVersionCommands(ctx: Context, parent: any, config: MinecraftToolsConfig): NodeJS.Timeout | undefined {
  // 注册查询版本信息命令
  parent.subcommand('.ver', '查询 Minecraft 版本信息')
    .usage('mc.ver - 获取 Minecraft 最新版本信息')
    .action(async () => {
      const result = await getVersionInfo()
      return result.success ? result.data : result.error
    })

  // 如果启用了版本更新检查，启动定时任务
  if (config.ver.enabled && config.ver.groups.length) {
    // 初始检查
    checkUpdate(ctx, config)
    // 设置定时任务
    const timer = setInterval(() => checkUpdate(ctx, config), config.ver.interval * 60 * 1000)
    return timer
  }
}
