import { h } from 'koishi'
import axios from 'axios'
import * as mc from 'minecraft-protocol'

// 类型定义
export type LangCode = keyof typeof MINECRAFT_LANGUAGES

export interface MinecraftVersionInfo {
  id: string
  type: string
  releaseTime: string
}

export interface SearchResult {
  title: string
  url: string
  desc?: string
  source: 'wiki' | 'mcmod'
}

export interface ModwikiConfig {
  searchDescLength: number
  totalPreviewLength: number
  searchTimeout: number
}

export interface MinecraftToolsConfig {
  wiki: {
    defaultLanguage: LangCode
    searchTimeout: number
    minSectionLength: number
    sectionPreviewLength: number
    totalPreviewLength: number
    searchDescLength: number
    showDescription: boolean
    imageEnabled: boolean
    showLinks: boolean
    showVersions: boolean
  }
  server: {
    address: string
    showPlayers: boolean
    showIcon: boolean
  }
  versionCheck: {
    enabled: boolean
    groups: string[]
    interval: number
    notifyOnSnapshot: boolean
    notifyOnRelease: boolean
  }
}

// 类型映射
export const TypeMap = {
  modTypes: {
    '/modpack/': '整合包',
    '/class/': 'MOD',
    '/item/': '物品',
    '/post/': '教程'
  },
  errorPatterns: {
    'ECONNREFUSED': '服务器拒绝连接',
    'ETIMEDOUT': '连接超时',
    'ENOTFOUND': '无法解析服务器地址',
    'ECONNRESET': '服务器断开了连接',
    'EHOSTUNREACH': '无法访问目标服务器',
    'ENETUNREACH': '网络不可达',
    'EPROTO': '协议错误',
    'ECONNABORTED': '连接中断',
    'EPIPE': '连接异常断开',
    'invalid server response': '服务器响应无效',
    'Unexpected server response': '服务器返回意外响应',
    'Invalid hostname': '无效的服务器地址',
    'getaddrinfo ENOTFOUND': '找不到服务器',
    'connect ETIMEDOUT': '连接超时',
    'read ECONNRESET': '服务器主动断开连接',
    'connect ECONNREFUSED': '服务器拒绝连接',
    'Request timeout': '请求超时',
    'network unreachable': '网络不可达',
    'port.*out of range': '端口号必须在1-65535之间',
    'dns lookup failed': 'DNS解析失败'
  }
} as const

// 1. 常量和类型定义
export const MINECRAFT_LANGUAGES = {
  'zh': '中文（简体）',
  'zh-hk': '中文（繁體）',
  'zh-tw': '中文（台灣）',
  'en': 'English',
  'ja': '日本語',
  'ko': '한국어',
  'fr': 'Français',
  'de': 'Deutsch',
  'es': 'Español',
  'it': 'Italiano',
  'pt': 'Português',
  'ru': 'Русский',
  'pl': 'Polski',
  'nl': 'Nederlands',
  'tr': 'Türkçe'
} as const

const MINECRAFT_PROTOCOL_VERSIONS = {
  764: '1.20.1',
  762: '1.19.4',
  756: '1.18.2',
  753: '1.17.1',
  752: '1.16.5',
  736: '1.15.2',
  498: '1.14.4',
  404: '1.13.2',
  340: '1.12.2',
  316: '1.11.2',
  210: '1.10.2',
  110: '1.9.4',
  47: '1.8.9'
} as const

/**
 * 获取 Minecraft 版本信息
 * @param {number} timeout - 请求超时时间(毫秒)
 * @returns {Promise<{latest: MinecraftVersionInfo, release: MinecraftVersionInfo, versions: MinecraftVersionInfo[]}>}
 * @throws {Error} 当版本数据无效或请求失败时抛出错误
 */
export async function fetchMinecraftVersions(timeout = 10000) {
  const { data } = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json', {
    timeout
  })

  const latest = data.versions[0]
  const release = data.versions.find(v => v.type === 'release')

  if (!latest || !release) {
    throw new Error('无效的版本数据')
  }

  return { latest, release, versions: data.versions }
}

/**
 * 获取格式化的 Minecraft 版本信息
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
export async function getMinecraftVersionInfo() {
  try {
    const { latest, release } = await fetchMinecraftVersions()
    const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN')

    return {
      success: true,
      data: `Minecraft 最新版本：\n正式版：${release.id}（${formatDate(release.releaseTime)}）\n快照版：${latest.id}（${formatDate(latest.releaseTime)}）`
    }
  } catch (error) {
    return {
      success: false,
      error: `获取版本信息失败：${error.message || String(error)}`
    }
  }
}

/**
 * 向目标群组发送版本更新通知
 * @param {any} ctx - Koishi 上下文
 * @param {string[]} targetGroups - 目标群组ID列表
 * @param {string} updateMessage - 更新消息内容
 */
async function notifyVersionUpdate(ctx: any, targetGroups: string[], updateMessage: string) {
  for (const gid of targetGroups) {
    for (const bot of ctx.bots) {
      try {
        await bot.sendMessage(gid, updateMessage)
      } catch (e) {
        ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
      }
    }
  }
}

/**
 * 检查 Minecraft 版本更新并发送通知
 * @param {{snapshot: string, release: string}} versions - 当前版本信息
 * @param {any} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export async function checkMinecraftUpdate(versions: { snapshot: string, release: string }, ctx: any, config: MinecraftToolsConfig) {
  try {
    const { latest, release } = await fetchMinecraftVersions()
    const updates = [
      { type: 'snapshot', version: latest, enabled: config.versionCheck.notifyOnSnapshot },
      { type: 'release', version: release, enabled: config.versionCheck.notifyOnRelease }
    ]

    for (const { type, version, enabled } of updates) {
      if (versions[type] && version.id !== versions[type] && enabled) {
        const msg = `发现MC更新：${version.id} (${type})\n发布时间：${new Date(version.releaseTime).toLocaleString('zh-CN')}`
        await notifyVersionUpdate(ctx, config.versionCheck.groups, msg)
      }
      versions[type] = version.id
    }
  } catch (error) {
    ctx.logger('mc-tools').warn('版本检查失败：', error)
  }
}

/**
 * 解析 Minecraft 服务器地址和端口
 * @param {string | undefined} serverAddress - 服务器地址字符串
 * @param {MinecraftToolsConfig['server']} defaultConfig - 默认服务器配置
 * @returns {{host: string, port: number}} 解析后的服务器信息
 * @throws {Error} 当地址格式无效时抛出错误
 */
function parseMinecraftServer(serverAddress: string | undefined, defaultConfig: MinecraftToolsConfig['server']) {
  const address = serverAddress || defaultConfig.address
  const [host, portStr] = address.split(':')
  if (!host) throw new Error('请输入有效的服务器地址')

  let port = 25565 // 默认端口
  if (portStr) {
    const parsedPort = parseInt(portStr)
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('端口号必须在1-65535之间')
    }
    port = parsedPort
  }

  return { host, port }
}

/**
 * 根据协议版本号获取对应的 Minecraft 版本
 * @param {number} protocol - 协议版本号
 * @returns {string} Minecraft 版本字符串
 */
function getVersionFromProtocol(protocol: number): string {
  if (protocol in MINECRAFT_PROTOCOL_VERSIONS) {
    return MINECRAFT_PROTOCOL_VERSIONS[protocol]
  }

  const protocols = Object.keys(MINECRAFT_PROTOCOL_VERSIONS).map(Number).sort((a, b) => b - a)
  for (let i = 0; i < protocols.length - 1; i++) {
    const current = protocols[i]
    const next = protocols[i + 1]

    if (protocol > current) {
      return `~${MINECRAFT_PROTOCOL_VERSIONS[current]}+`
    }
    if (protocol > next && protocol < current) {
      return `~${MINECRAFT_PROTOCOL_VERSIONS[next]}-${MINECRAFT_PROTOCOL_VERSIONS[current]}`
    }
  }

  return protocol < 47 ? '~1.8.9' : `未知版本(协议:${protocol})`
}

/**
 * 解析服务器 MOTD 信息
 * @param {any} motdObject - MOTD 对象或字符串
 * @returns {string} 解析后的 MOTD 文本
 */
function parseServerMotd(motdObject: any): string {
  if (!motdObject) return ''
  if (typeof motdObject === 'string') return motdObject
  if (typeof motdObject !== 'object') return ''

  if ('text' in motdObject) return motdObject.text
  if ('extra' in motdObject && Array.isArray(motdObject.extra)) {
    return motdObject.extra.map(parseServerMotd).join('')
  }
  if (Array.isArray(motdObject)) {
    return motdObject.map(parseServerMotd).join('')
  }
  return ''
}

/**
 * 格式化错误消息
 * @param {any} error - 错误对象
 * @returns {string} 格式化后的错误消息
 */
export function formatErrorMessage(error: any): string {
  const errorMessage = error?.message || String(error)

  if (error?.code && TypeMap.errorPatterns[error.code]) {
    return TypeMap.errorPatterns[error.code]
  }

  for (const [pattern, message] of Object.entries(TypeMap.errorPatterns)) {
    if (new RegExp(pattern, 'i').test(errorMessage)) {
      return message
    }
  }

  return `无法连接到服务器: ${errorMessage}`
}

/**
 * 检查服务器状态
 * @param {string | undefined} server - 服务器地址
 * @param {MinecraftToolsConfig} config - 插件配置
 * @returns {Promise<string>} 格式化的服务器状态信息
 */
export async function checkServerStatus(server: string | undefined, config: MinecraftToolsConfig) {
  const { host, port } = parseMinecraftServer(server, config.server)
  const displayAddr = port === 25565 ? host : `${host}:${port}`

  const startTime = Date.now()
  const client = await mc.ping({ host, port })
  const pingTime = Date.now() - startTime

  const lines: string[] = []

  // 处理服务器图标
  if (config.server.showIcon && 'favicon' in client && client.favicon?.startsWith('data:image/png;base64,')) {
    lines.push(h.image(client.favicon).toString())
  }

  // 处理服务器描述
  const description = 'description' in client ? client.description : client
  if (description) {
    const motd = parseServerMotd(description).replace(/§[0-9a-fk-or]/g, '')
    if (motd) lines.push(motd)
  }

  // 处理版本信息和玩家数据
  const version = client?.version
  const players = 'players' in client ? {
    online: client.players?.online ?? 0,
    max: client.players?.max ?? 0,
    sample: client.players?.sample ?? []
  } : null

  const versionStr = !version ? '未知版本' : (
    typeof version === 'object'
      ? `${version.name}(${getVersionFromProtocol(version.protocol)})`
      : String(version)
  )

  // 状态行
  const statusParts = [versionStr]
  if (players) statusParts.push(`${players.online}/${players.max}`)
  statusParts.push(`${pingTime}ms`)
  lines.push(statusParts.join(' | '))

  // 在线玩家列表
  if (config.server.showPlayers && players?.sample?.length > 0) {
    const playerNames = players.sample
      .filter(p => p && typeof p.name === 'string')
      .map(p => p.name)

    if (playerNames.length > 0) {
      const playerInfo = ['当前在线：' + playerNames.join(', ')]
      if (playerNames.length < players.online) {
        playerInfo.push(`（仅显示 ${playerNames.length}/${players.online} 名玩家）`)
      }
      lines.push(playerInfo.join(''))
    }
  }

  const data = lines.join('\n')
  return server ? data : `${displayAddr}\n${data}`
}
