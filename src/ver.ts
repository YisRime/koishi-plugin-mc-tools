import { Context, Logger } from 'koishi'
import axios from 'axios'
import { MinecraftToolsConfig } from './index'
import * as fs from 'fs'
import * as path from 'path'

const logger = new Logger('mcver')

const API_SOURCES = {
  MOJANG: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  BMCLAPI: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json',
}

interface VersionData {
  latest: {
    release: string
    snapshot: string
  }
  versions?: any[]
}

/**
 * 获取 Minecraft 版本信息
 * @param {number} timeout - 请求超时时间(毫秒)
 * @returns {Promise<VersionData>}
 * @throws {Error} 当所有 API 源都请求失败时抛出错误
 */
async function fetchVersions(timeout = 10000): Promise<VersionData> {
  const apiSources = Object.values(API_SOURCES)
  let lastError = null

  for (const apiUrl of apiSources) {
    try {
      const { data } = await axios.get(apiUrl, { timeout })

      if (!data.latest || !data.latest.release || !data.latest.snapshot) {
        throw new Error('版本数据解析失败')
      }

      return { latest: data.latest, versions: data.versions }
    } catch (error) {
      lastError = error
      logger.warn(`API 源 ${apiUrl} 请求失败:`, error.message || String(error))
      continue
    }
  }

  throw new Error(`所有 API 源均请求失败: ${lastError?.message || String(lastError)}`)
}

/**
 * 保存版本信息到本地文件
 * @param {Context} ctx - Koishi 上下文
 * @param {Object} versions - 版本信息对象
 */
async function saveVersionsToFile(ctx: Context, versions: {release: string, snapshot: string}) {
  try {
    const dataDir = path.join(ctx.baseDir, 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    const filePath = path.join(dataDir, 'mcver-latest.json')
    fs.writeFileSync(filePath, JSON.stringify(versions, null, 2), 'utf-8')
  } catch (error) {
    logger.warn('保存版本信息失败:', error)
  }
}

/**
 * 从本地文件读取版本信息
 * @param {Context} ctx - Koishi 上下文
 * @returns {Object} 版本信息对象
 */
function loadVersionsFromFile(ctx: Context): {release: string, snapshot: string} {
  try {
    const filePath = path.join(ctx.baseDir, 'data/mcver-latest.json')
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(data)
    }
  } catch (error) {
    logger.warn('读取版本信息失败:', error)
  }
  return { release: '', snapshot: '' }
}

/**
 * 获取格式化的 Minecraft 版本信息
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
async function getVersionInfo() {
  try {
    const { latest } = await fetchVersions()

    return {
      success: true,
      data: `Minecraft 最新版本：\n正式版: ${latest.release}\n快照版: ${latest.snapshot}`
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
 * 检查 Minecraft 版本更新并发送通知
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
async function checkUpdate(ctx: Context, config: MinecraftToolsConfig) {
  try {
    // 从本地加载之前的版本信息
    const savedVersions = loadVersionsFromFile(ctx)

    // 获取最新版本信息
    const { latest } = await fetchVersions()

    // 检查是否有更新
    if (config.ver.release && latest.release !== savedVersions.release) {
      const msg = `Minecraft 正式版更新：${latest.release}`
      await notifyVersionUpdate(ctx, config.ver.groups, msg)
    }

    if (config.ver.snapshot && latest.snapshot !== savedVersions.snapshot) {
      const msg = `Minecraft 快照版更新：${latest.snapshot}`
      await notifyVersionUpdate(ctx, config.ver.groups, msg)
    }

    // 保存新版本信息到本地
    await saveVersionsToFile(ctx, latest)

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
    // 立即检查一次
    checkUpdate(ctx, config)
    // 设置定时检查
    const timer = setInterval(() => checkUpdate(ctx, config), config.ver.interval * 60 * 1000)
    return timer
  }
}
