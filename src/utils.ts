import { h } from 'koishi'
import axios from 'axios'
import * as mc from 'minecraft-protocol'

// 语言定义
export const LANGUAGES = {
  'zh': '中文（简体）',
  'zh-hk': '中文（繁體）',
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

export type LangCode = keyof typeof LANGUAGES

// 错误处理相关
const ERROR_MESSAGES = {
  network: {
    ECONNREFUSED: '连接被服务器拒绝',
    ETIMEDOUT: '服务器响应超时',
    ENOTFOUND: '无法解析服务器地址',
    ECONNRESET: '服务器断开了连接',
  },
  server: {
    invalid_address: '无效的服务器地址',
    invalid_response: '服务器返回数据无效',
    version_invalid: '无效的版本数据'
  }
} as const

export function formatErrorMessage(error: any): string {
  if (!error) return '发生未知错误'

  if (error.code && error.code in ERROR_MESSAGES.network) {
    return ERROR_MESSAGES.network[error.code]
  }

  return error.message || String(error)
}

// 服务器状态处理
interface ServerConfig {
  showPlayers: boolean
  showSettings: boolean
  showPing: boolean
  showIcon: boolean
}

interface ServerStatus {
  success: boolean
  data?: string
  error?: string
}

// 版本映射表（从新到旧排序）
const MC_VERSIONS = [
  { protocol: 764, version: '1.20.1' },
  { protocol: 762, version: '1.19.4' },
  { protocol: 756, version: '1.18.2' },
  { protocol: 753, version: '1.17.1' },
  { protocol: 752, version: '1.16.5' },
  { protocol: 736, version: '1.15.2' },
  { protocol: 498, version: '1.14.4' },
  { protocol: 404, version: '1.13.2' },
  { protocol: 340, version: '1.12.2' },
  { protocol: 316, version: '1.11.2' },
  { protocol: 210, version: '1.10.2' },
  { protocol: 110, version: '1.9.4' },
  { protocol: 47, version: '1.8.9' }
] as const

export function getMinecraftVersion(protocol: number): string {
  const exactMatch = MC_VERSIONS.find(v => v.protocol === protocol)
  if (exactMatch) return exactMatch.version

  for (let i = 0; i < MC_VERSIONS.length - 1; i++) {
    const current = MC_VERSIONS[i]
    const next = MC_VERSIONS[i + 1]

    if (protocol > current.protocol) {
      return `~${current.version}+`
    }

    if (protocol > next.protocol && protocol < current.protocol) {
      return `~${next.version}-${current.version}`
    }
  }

  return protocol < MC_VERSIONS[MC_VERSIONS.length - 1].protocol
    ? `~${MC_VERSIONS[MC_VERSIONS.length - 1].version}-`
    : `未知版本(协议:${protocol})`
}

function parseMessage(obj: any): string {
  if (!obj) return ''
  if (typeof obj === 'string') return obj
  if (typeof obj === 'object') {
    if ('text' in obj) return obj.text
    if ('extra' in obj && Array.isArray(obj.extra)) {
      return obj.extra.map(parseMessage).join('')
    }
    if (Array.isArray(obj)) {
      return obj.map(parseMessage).join('')
    }
  }
  return ''
}

async function queryServer(host: string, port: number): Promise<any> {
  const MAX_RETRIES = 2
  const RETRY_DELAY = 1000

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await mc.ping({ host, port })
    } catch (error) {
      if (i === MAX_RETRIES) throw error
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
    }
  }
}

export async function queryServerStatus(host: string, port: number, config: ServerConfig): Promise<ServerStatus> {
  try {
    const startTime = Date.now()
    const client = await queryServer(host, port)
    const pingTime = Date.now() - startTime

    const lines = processServerResponse(client, pingTime, config)
    return { success: true, data: lines.join('\n') }
  } catch (error) {
    return { success: false, error: formatErrorMessage(error) }
  }
}

function processServerResponse(client: any, pingTime: number, config: ServerConfig): string[] {
  const lines: string[] = []

  // 处理服务器图标
  if (config.showIcon && client?.favicon?.startsWith('data:image/png;base64,')) {
    lines.push(h.image(client.favicon).toString())
  }

  // 处理服务器描述
  if (client?.description) {
    const motd = parseMessage(client.description).trim()
    if (motd) lines.push(motd.replace(/§[0-9a-fk-or]/g, ''))
  }

  // 处理版本信息和玩家数量
  const versionInfo = processVersionInfo(client?.version)
  const players = {
    online: client?.players?.online ?? 0,
    max: client?.players?.max ?? 0,
    sample: client?.players?.sample ?? []
  }

  const statusParts = [versionInfo, `${players.online}/${players.max}`]
  if (config.showPing) statusParts.push(`${pingTime}ms`)
  lines.push(statusParts.join(' | '))

  // 处理服务器设置
  if (config.showSettings) {
    const settings = processServerSettings(client)
    if (settings.length) lines.push(settings.join(' | '))
  }

  // 处理在线玩家列表
  if (config.showPlayers && players.sample?.length) {
    const playerList = players.sample
      .filter(p => p?.name)
      .map(p => p.name)

    if (playerList.length) {
      let playerInfo = '当前在线：' + playerList.join(', ')
      if (playerList.length < players.online) {
        playerInfo += `（仅显示 ${playerList.length}/${players.online} 名玩家）`
      }
      lines.push(playerInfo)
    }
  }

  return lines
}

function processVersionInfo(version: any): string {
  if (!version) return '未知版本'

  const name = typeof version === 'object' ? version.name : String(version)
  const protocol = typeof version === 'object' ? version.protocol : null

  return protocol
    ? `${name}(${getMinecraftVersion(protocol)})`
    : name
}

function processServerSettings(client: any): string[] {
  const settings: string[] = []

  if ('onlineMode' in client) {
    settings.push(client.onlineMode ? '正版验证' : '离线模式')
  }
  if ('enforceSecureChat' in client) {
    settings.push(client.enforceSecureChat ? '开启签名' : '无需签名')
  }
  if ('whitelist' in client) {
    settings.push(client.whitelist ? '有白名单' : '无白名单')
  }

  return settings
}

// 版本更新检查
export interface VersionInfo {
  id: string
  type: string
  releaseTime: string
}

export interface VersionState {
  snapshot: string
  release: string
}

// 简化的配置接口
export interface MinecraftToolsConfig {
  wiki: {
    defaultLanguage: LangCode
    pageTimeout: number
    searchTimeout: number
    searchResultLimit: number
    minSectionLength: number
    sectionPreviewLength: number
    totalPreviewLength: number
    searchDescLength: number
    imageEnabled: boolean
  }
  server: {
    host: string
    port: number
    showPlayers: boolean
    showSettings: boolean
    showPing: boolean
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

export async function fetchMinecraftVersions(timeout = 10000) {
  const { data } = await axios.get(
    'https://launchermeta.mojang.com/mc/game/version_manifest.json',
    { timeout }
  )

  const latest = data.versions[0]
  const release = data.versions.find(v => v.type === 'release')

  if (!latest || !release) {
    throw new Error(ERROR_MESSAGES.server.version_invalid)
  }

  return { latest, release, versions: data.versions }
}

export async function checkMinecraftUpdate(
  state: VersionState,
  ctx: any,
  config: MinecraftToolsConfig
) {
  const MAX_RETRIES = 3
  const RETRY_DELAY = 30000

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const { latest, release } = await fetchMinecraftVersions()
      processVersionUpdates(state, latest, release, ctx, config)
      break
    } catch (error) {
      const isLastRetry = i === MAX_RETRIES - 1
      ctx.logger('mc-tools').warn(
        isLastRetry
          ? '版本检查失败（已达最大重试次数）：'
          : `版本检查失败（将在${RETRY_DELAY/1000}秒后重试）：`,
        error
      )
      if (!isLastRetry) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
      }
    }
  }
}

function processVersionUpdates(
  state: VersionState,
  latest: VersionInfo,
  release: VersionInfo,
  ctx: any,
  config: MinecraftToolsConfig
) {
  const updates = [
    { type: 'snapshot', version: latest, enabled: config.versionCheck.notifyOnSnapshot },
    { type: 'release', version: release, enabled: config.versionCheck.notifyOnRelease }
  ]

  for (const { type, version, enabled } of updates) {
    if (state[type] && version.id !== state[type] && enabled) {
      notifyUpdate(version, type, ctx, config)
    }
    state[type] = version.id
  }
}

function notifyUpdate(version: VersionInfo, type: string, ctx: any, config: MinecraftToolsConfig) {
  const msg = `发现MC更新：${version.id} (${type})\n发布时间：${new Date(version.releaseTime).toLocaleString('zh-CN')}`

  for (const gid of config.versionCheck.groups) {
    for (const bot of ctx.bots) {
      bot.sendMessage(gid, msg).catch(e => {
        ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
      })
    }
  }
}
