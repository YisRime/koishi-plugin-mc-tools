import { h } from 'koishi'
import axios from 'axios'
import * as mc from 'minecraft-protocol'

// 语言定义
export const LANGUAGES = {
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

const PROTOCOL_VERSION_MAP = {
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

export type LangCode = keyof typeof LANGUAGES

export interface VersionData {
  id: string
  type: string
  releaseTime: string
}

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

async function sendUpdateNotification(ctx: any, gids: string[], message: string) {
  for (const gid of gids) {
    for (const bot of ctx.bots) {
      try {
        await bot.sendMessage(gid, message)
      } catch (e) {
        ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
      }
    }
  }
}

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
        await sendUpdateNotification(ctx, config.versionCheck.groups, msg)
      }
      versions[type] = version.id
    }
  } catch (error) {
    ctx.logger('mc-tools').warn('版本检查失败：', error)
  }
}

// 辅助函数：解析服务器地址
function parseServerAddress(server: string | undefined, defaultConfig: MinecraftToolsConfig['server']) {
  if (!server) return { host: defaultConfig.host, port: defaultConfig.port }

  const [host, portStr] = server.split(':')
  if (!host) throw new Error('请输入有效的服务器地址')

  let port = defaultConfig.port
  if (portStr) {
    const parsedPort = parseInt(portStr)
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('端口必须是1-65535之间的数字')
    }
    port = parsedPort
  }

  return { host, port }
}

// 辅助函数：获取协议对应版本
function getVersionFromProtocol(protocol: number): string {
  if (protocol in PROTOCOL_VERSION_MAP) {
    return PROTOCOL_VERSION_MAP[protocol]
  }

  const protocols = Object.keys(PROTOCOL_VERSION_MAP).map(Number).sort((a, b) => b - a)
  for (let i = 0; i < protocols.length - 1; i++) {
    const current = protocols[i]
    const next = protocols[i + 1]

    if (protocol > current) {
      return `~${PROTOCOL_VERSION_MAP[current]}+`
    }
    if (protocol > next && protocol < current) {
      return `~${PROTOCOL_VERSION_MAP[next]}-${PROTOCOL_VERSION_MAP[current]}`
    }
  }

  return protocol < 47 ? '~1.8.9' : `未知版本(协议:${protocol})`
}

// 辅助函数：解析MOTD
function parseMOTD(obj: any): string {
  if (!obj) return ''
  if (typeof obj === 'string') return obj
  if (typeof obj !== 'object') return ''

  if ('text' in obj) return obj.text
  if ('extra' in obj && Array.isArray(obj.extra)) {
    return obj.extra.map(parseMOTD).join('')
  }
  if (Array.isArray(obj)) {
    return obj.map(parseMOTD).join('')
  }
  return ''
}

// 辅助函数：格式化错误消息
export function formatErrorMessage(error: any): string {
  const errorMessage = error?.message || String(error)

  // 简化的错误映射对象
  const errorPatterns = {
    // 网络连接错误
    'ECONNREFUSED': '服务器拒绝连接',
    'ETIMEDOUT': '连接超时',
    'ENOTFOUND': '无法解析服务器地址',
    'ECONNRESET': '服务器断开了连接',
    'EHOSTUNREACH': '无法访问目标服务器',
    'ENETUNREACH': '网络不可达',
    'EPROTO': '协议错误',
    'ECONNABORTED': '连接被中断',
    'EPIPE': '连接异常断开',

    // 服务器响应错误
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
  } as const

  // 检查错误代码或消息匹配
  if (error?.code && errorPatterns[error.code]) {
    return errorPatterns[error.code]
  }

  // 检查错误消息包含的关键字
  for (const [pattern, message] of Object.entries(errorPatterns)) {
    if (new RegExp(pattern, 'i').test(errorMessage)) {
      return message
    }
  }

  return `无法连接到服务器: ${errorMessage}`
}

export async function checkServerStatus(server: string | undefined, config: MinecraftToolsConfig) {
  const { host, port } = parseServerAddress(server, config.server)
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
    const motd = parseMOTD(description).replace(/§[0-9a-fk-or]/g, '')
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
  if (config.server.showPing) statusParts.push(`${pingTime}ms`)
  lines.push(statusParts.join(' | '))

  // 服务器设置
  if (config.server.showSettings) {
    const settings = [
      'onlineMode' in client && (client.onlineMode ? '正版验证' : '离线模式'),
      'enforceSecureChat' in client && (client.enforceSecureChat ? '开启签名' : '无需签名'),
      'whitelist' in client && (client.whitelist ? '有白名单' : '无白名单')
    ].filter(Boolean)

    if (settings.length) lines.push(settings.join(' | '))
  }

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
