import { h } from 'koishi'
import axios from 'axios';
import * as mc from 'minecraft-protocol'

// 1. 常量和类型定义
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
    imagePriority: number
    imageMaxWidth: number
    imageQuality: number
    cleanupTags: string[]
  }
  server: {
    host: string
    port: number
    queryTimeout: number
    retryAttempts: number
    retryDelay: number
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

// 2. 基础工具函数
export function formatErrorMessage(error: any): string {
  if (!error) return '未知错误'
  const message = error.message || String(error)

  const networkErrors = {
    ECONNREFUSED: '无法连接服务器',
    ETIMEDOUT: '连接超时',
    ENOTFOUND: '找不到服务器',
    ECONNRESET: '连接被重置',
  }

  if (error.code in networkErrors) {
    return networkErrors[error.code]
  }

  return message
}

export function parseServerMessage(obj: any): string {
  if (!obj) return ''
  if (typeof obj === 'string') return obj
  if (typeof obj === 'object') {
    if ('text' in obj) return obj.text
    if ('extra' in obj && Array.isArray(obj.extra)) {
      return obj.extra.map(parseServerMessage).join('')
    }
    if (Array.isArray(obj)) {
      return obj.map(parseServerMessage).join('')
    }
  }
  return ''
}

export function isSearchAllowed(lastSearchTime: number): number | false {
  const now = Date.now()
  const SEARCH_COOLDOWN = 1000
  if (now - lastSearchTime < SEARCH_COOLDOWN) return false
  return now
}

// 4. 服务器相关函数
export function getMinecraftVersionFromProtocol(protocol: number): string {
  const protocolMap: Record<number, string> = {
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
  }

  if (protocol in protocolMap) {
    return protocolMap[protocol]
  }

  const protocols = Object.keys(protocolMap).map(Number).sort((a, b) => b - a)

  for (let i = 0; i < protocols.length; i++) {
    const currentProtocol = protocols[i]
    const nextProtocol = protocols[i + 1]

    if (protocol > currentProtocol) {
      return `~${protocolMap[currentProtocol]}+`
    } else if (nextProtocol && protocol > nextProtocol && protocol < currentProtocol) {
      return `~${protocolMap[nextProtocol]}-${protocolMap[currentProtocol]}`
    }
  }

  if (protocol < 47) {
    return '~1.8.9'
  }

  return `未知版本(协议:${protocol})`
}

export function parseServerPlayerStats(players: any) {
  if (!players) return { online: 0, max: 0 }
  return {
    online: players.online ?? 0,
    max: players.max ?? 0,
    sample: players.sample ?? []
  }
}

export function parseServerConfiguration(client: any) {
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

export interface VersionData {
  id: string
  type: string
  releaseTime: string
}

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

export async function checkMinecraftUpdate(versions: { snapshot: string, release: string }, ctx: any, config: MinecraftToolsConfig) {
  const retryCount = 3
  const retryDelay = 30000

  for (let i = 0; i < retryCount; i++) {
    try {
      const { latest, release } = await fetchMinecraftVersions()

      for (const [type, ver] of [['snapshot', latest], ['release', release]]) {
        if (versions[type] && ver.id !== versions[type] &&
            ((type === 'snapshot' && config.versionCheck.notifyOnSnapshot) ||
             (type === 'release' && config.versionCheck.notifyOnRelease))) {
          const msg = `发现MC更新：${ver.id} (${type})\n发布时间：${new Date(ver.releaseTime).toLocaleString('zh-CN')}`
          for (const gid of config.versionCheck.groups) {
            for (const bot of ctx.bots) {
              await bot.sendMessage(gid, msg).catch(e => {
                ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
              })
            }
          }
        }
        versions[type] = ver.id
      }
      break
    } catch (error) {
      if (i === retryCount - 1) {
        ctx.logger('mc-tools').warn('版本检查失败（已达最大重试次数）：', error)
      } else {
        ctx.logger('mc-tools').warn(`版本检查失败（将在${retryDelay/1000}秒后重试）：`, error)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      }
    }
  }
}

export async function queryServerStatus(host: string, port: number, config: MinecraftToolsConfig) {
  try {
    const startTime = Date.now()
    const client = await mc.ping({
      host,
      port,
    })
    const pingTime = Date.now() - startTime

    const lines: string[] = []

    if (config.server.showIcon && client && 'favicon' in client && client.favicon?.startsWith('data:image/png;base64,')) {
      lines.push(h.image(client.favicon).toString())
    }

    if ('description' in client && client.description) {
      const motd = parseServerMessage(client.description).trim()
      if (motd) {
        lines.push(motd.replace(/§[0-9a-fk-or]/g, ''))
      }
    }

    let versionInfo = '未知版本'
    if (client?.version) {
      const currentVersion = typeof client.version === 'object'
        ? (client.version.name || '未知版本')
        : String(client.version)

      const protocol = typeof client.version === 'object'
        ? client.version.protocol
        : null

      versionInfo = protocol
        ? `${currentVersion}(${getMinecraftVersionFromProtocol(protocol)})`
        : currentVersion
    }

    const players = 'players' in client ? parseServerPlayerStats(client.players) : { online: 0, max: 0 }
    const statusParts = [versionInfo, `${players.online}/${players.max}`]
    if (config.server.showPing) {
      statusParts.push(`${pingTime}ms`)
    }
    lines.push(statusParts.join(' | '))

    if (config.server.showSettings) {
      const settings = parseServerConfiguration(client)
      if (settings.length) {
        lines.push(settings.join(' | '))
      }
    }

    if (config.server.showPlayers && players.sample?.length > 0) {
      const playerList = players.sample
        .filter(p => p && typeof p.name === 'string')
        .map(p => p.name)
      if (playerList.length > 0) {
        let playerInfo = '当前在线：' + playerList.join(', ')
        if (playerList.length < players.online) {
          playerInfo += `（仅显示 ${playerList.length}/${players.online} 名玩家）`
        }
        lines.push(playerInfo)
      }
    }

    return { success: true, data: lines.join('\n') }
  } catch (error) {
    if (config.server.retryAttempts > 0) {
      await new Promise(resolve => setTimeout(resolve, config.server.retryDelay * 1000))
      try {
        return await queryServerStatus(host, port, { ...config, server: { ...config.server, retryAttempts: config.server.retryAttempts - 1 } })
      } catch (retryError) {
        return { success: false, error: formatErrorMessage(error) }
      }
    }
    return { success: false, error: formatErrorMessage(error) }
  }
}
