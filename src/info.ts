import { h } from 'koishi'
import { MinecraftToolsConfig } from './index'
import axios from 'axios'

export interface ServerStatus {
  online: boolean
  ip: string
  port: number
  motd?: { raw?: string }
  version: { name: string }
  players: {
    online: number
    max: number
    sample?: { name: string }[]
  }
  favicon?: string
  ping?: number
  error?: string
  description?: string
  modInfo?: {
    type?: string
    modList?: { name: string; version?: string }[]
  }
  software?: string
  gameType?: string
  platform?: string
  serverId?: string
  map?: string
  plugins?: string[]
  hostip?: string
}

interface ParsedServer {
  host: string
  port?: number
  type: 'java' | 'bedrock'
}

function parseServerAddress(input?: string, defaultServer?: string): ParsedServer {
  let server = input || defaultServer || 'localhost'
  let type: 'java' | 'bedrock' = 'java'
  const defaultPorts = { java: 25565, bedrock: 19132 }

  let host: string
  let port: number | undefined

  if (server.includes('[')) {
    const ipv6Match = server.match(/\[(.*?)\](?::(\d+))?/)
    if (ipv6Match) {
      host = ipv6Match[1]
      port = ipv6Match[2] ? parseInt(ipv6Match[2]) : undefined
    } else {
      throw new Error('无效的 IPv6 地址格式')
    }
  } else {
    const parts = server.split(':')
    host = parts[0]
    port = parts[1] ? parseInt(parts[1]) : undefined
  }

  if (port !== undefined && (isNaN(port) || port < 1 || port > 65535)) {
    throw new Error('无效的端口号（应为1-65535）')
  }

  return { host, port: port || defaultPorts[type], type }
}

export async function checkServerStatus(
  server?: string,
  forceType?: 'java' | 'bedrock',
  config?: MinecraftToolsConfig
): Promise<ServerStatus> {
  try {
    const parsed = parseServerAddress(server, config?.info.default)
    const type = forceType || parsed.type

    const apis = type === 'java' ? config?.info.javaApis : config?.info.bedrockApis
    if (!apis?.length) {
      throw new Error(`未配置 ${type === 'java' ? 'Java' : 'Bedrock'} 查询 API`)
    }

    let lastError: Error
    for (const apiTemplate of apis) {
      try {
        const url = apiTemplate
          .replace(/\${host}/g, parsed.host)
          .replace(/\${port}/g, String(parsed.port))

        const response = await axios.get(url, {
          timeout: 10000,
          validateStatus: null
        })

        if (!response.data || response.status !== 200) {
          throw new Error(response.data?.error || `${response.status}`)
        }

        const data = response.data

        if (data.status === 'offline' || data.status === false ||
            data.status === 'Offline' || data.status?.toLowerCase() === 'offline') {
          throw new Error('服务器离线')
        }

        const version = data.version ?? data.version?.version ?? data.server_version
        const playersOnline = Number(data.players_online ?? data.players?.online ?? data.online)
        const playersMax = Number(data.players_max ?? data.players?.max ?? data.max)
        const motd = data.motd ?? data.motd?.ingame ?? data.motd?.clean ?? data.description

        if ((!version || version === '未知') &&
            (isNaN(playersOnline) || isNaN(playersMax)) &&
            !motd) {
          throw new Error('获取到的数据无效')
        }

        return {
          online: true,
          ip: parsed.host,
          port: parsed.port,
          motd: { raw: motd },
          version: { name: version ?? '未知' },
          players: {
            online: playersOnline || 0,
            max: playersMax || 0,
            sample: data.players ?? data.players?.list ?? data.sample ?? []
          },
          favicon: data.favicon ?? data.icon,
          ping: data.ping ?? (data.queryinfo?.processed ? parseInt(data.queryinfo.processed) : undefined),
          modInfo: data.modInfo ? {
            type: data.modInfo.type,
            modList: data.modInfo.modList
          } : undefined,
          software: data.software,
          gameType: data.gametype,
          platform: data.platform,
          serverId: data.serverId,
          map: data.map,
          plugins: data.plugins,
          hostip: data.hostip
        }
      } catch (error) {
        lastError = error
        continue
      }
    }

    throw lastError || new Error('所有 API 均查询失败')
  } catch (error) {
    return {
      online: false,
      ip: error['host'] || '未知',
      port: error['port'],
      version: { name: '未知' },
      players: { online: 0, max: 0 },
      error: error.message || '查询失败'
    }
  }
}

function stripColorCodes(text: string): string {
  return text.replace(/§[0-9a-fk-or]/gi, '')
}

function parseMOTDJson(obj: any): string {
  if (typeof obj === 'string') return stripColorCodes(obj)
  if (!obj) return ''

  let result = ''

  if (obj.text) result += stripColorCodes(obj.text)
  if (Array.isArray(obj.extra)) {
    result += obj.extra.map(item => parseMOTDJson(item)).join('')
  } else if (typeof obj.extra === 'object') {
    result += parseMOTDJson(obj.extra)
  }

  return result
}

export function formatServerStatus(status: ServerStatus, config: MinecraftToolsConfig['info']) {
  const lines: string[] = []

  if (!status.online) {
    return `离线 - ${status.error || '无法连接到服务器'}`
  }

  if (config.showIcon && status.favicon?.startsWith('data:image/png;base64,')) {
    lines.push(h.image(status.favicon).toString())
  }

  if (status.motd?.raw) {
    let motdText: string
    try {
      const motdJson = typeof status.motd.raw === 'string' ?
        JSON.parse(status.motd.raw) : status.motd.raw
      motdText = parseMOTDJson(motdJson)
    } catch (e) {
      motdText = stripColorCodes(String(status.motd.raw))
    }
    if (motdText.trim()) lines.push(motdText)
  } else if (status.description) {
    lines.push(stripColorCodes(status.description))
  }

  const statusParts = [
    status.version?.name || '未知',
    `${status.players?.online || 0}/${status.players?.max || 0}`,
  ]
  if (status.ping) statusParts.push(`${status.ping}ms`)
  lines.push(statusParts.join(' | '))

  if (config.maxPlayerDisplay > 0 && status.players?.sample?.length) {
    const displayCount = Math.min(config.maxPlayerDisplay, status.players.sample.length)
    const playerNames = status.players.sample
      .slice(0, displayCount)
      .map(p => p.name)
      .join(', ')

    const playerInfo = ['当前在线：' + playerNames]
    if (status.players.online > displayCount) {
      playerInfo.push(`（等共 ${status.players.online} 名）`)
    }
    lines.push(playerInfo.join(''))
  }

  if (status.modInfo?.modList?.length) {
    lines.push('\n模组信息：')
    lines.push(`类型：${status.modInfo.type || '未知'}`)
    lines.push(`已安装：${status.modInfo.modList.length} 个模组`)
    if (config.maxModDisplay > 0) {
      const displayCount = Math.min(config.maxModDisplay, status.modInfo.modList.length)
      const modList = status.modInfo.modList
        .slice(0, displayCount)
        .map(mod => mod.version ? `${mod.name} (${mod.version})` : mod.name)
        .join(', ')
      lines.push(`模组列表：${modList}`)
      if (status.modInfo.modList.length > displayCount) {
        lines.push(`（等共 ${status.modInfo.modList.length} 个模组）`)
      }
    }
  }

  const additionalInfo = []
  if (status.software && !status.software.includes('超时')) additionalInfo.push(`服务端：${status.software}`)
  if (status.map && !status.map.includes('超时')) additionalInfo.push(`地图：${status.map}`)
  if (status.plugins?.length && Array.isArray(status.plugins)) additionalInfo.push(`插件数：${status.plugins.length}`)
  if (status.gameType && !status.gameType.includes('超时')) additionalInfo.push(`游戏类型：${status.gameType}`)
  if (status.platform && !status.platform.includes('超时')) additionalInfo.push(`平台：${status.platform}`)

  if (additionalInfo.length > 0) {
    lines.push('\n服务器信息：')
    lines.push(additionalInfo.join(' | '))
  }

  return lines.join('\n')
}
