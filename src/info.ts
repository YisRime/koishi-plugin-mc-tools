import { h } from 'koishi'
import { MinecraftToolsConfig } from './index'
import axios from 'axios'

/**
 * 表示 Minecraft 服务器状态的接口
 * @interface ServerStatus
 */
export interface ServerStatus {
  online: boolean
  ip: string
  port: number
  ip_address?: string
  eula_blocked?: boolean
  retrieved_at?: number
  expires_at?: number
  version?: {
    name: string
    name_raw?: string
    name_clean?: string
    name_html?: string
    protocol?: number
  }
  players: {
    online: number
    max: number
    list?: {
      uuid?: string
      name_raw?: string
      name_clean?: string
      name_html?: string
    }[]
  }
  motd?: {
    raw?: string
    clean?: string
    html?: string
  }
  icon?: string
  mods?: {
    name: string
    version?: string
  }[]
  software?: string
  plugins?: {
    name: string
    version?: string | null
  }[]
  srv_record?: {
    host: string
    port: number
  }
  error?: string
  description?: string
  modInfo?: {
    type?: string
    modList?: { name: string; version?: string }[]
  }
  gameType?: string
  platform?: string
  serverId?: string
  map?: string
  hostip?: string
  gamemode?: string
  server_id?: string
  edition?: 'MCPE' | 'MCEE' | null
}

/**
 * 表示解析后的服务器地址信息
 * @interface ParsedServer
 */
interface ParsedServer {
  host: string
  port?: number
  type: 'java' | 'bedrock'
}

/**
 * 解析 Minecraft 服务器地址
 * @param {string} [input] - 输入的服务器地址，格式可以是 "host:port" 或 "[ipv6]:port"
 * @param {string} [defaultServer] - 默认服务器地址
 * @returns {ParsedServer} 解析后的服务器信息
 * @throws {Error} 当输入的地址格式无效时抛出错误
 * @example
 * parseServerAddress('localhost:25565') // { host: 'localhost', port: 25565, type: 'java' }
 * parseServerAddress('[2001:db8::1]:19132') // { host: '2001:db8::1', port: 19132, type: 'bedrock' }
 */
function parseServerAddress(input?: string, defaultServer?: string): ParsedServer {
  let server = input || defaultServer || 'localhost'
  const defaultPorts = { java: 25565, bedrock: 19132 }

  let host: string
  let port: number | undefined
  let type: 'java' | 'bedrock' = 'java'

  if (server.includes(':')) {
    const portNum = parseInt(server.split(':')[1])
    if (portNum === defaultPorts.bedrock) {
      type = 'bedrock'
    }
  }

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

/**
 * 检查 Minecraft 服务器状态
 * @param {string} [server] - 服务器地址
 * @param {'java' | 'bedrock'} [forceType] - 强制指定服务器类型
 * @param {MinecraftToolsConfig} [config] - 配置选项
 * @returns {Promise<ServerStatus>} 服务器状态信息
 * @example
 * await checkServerStatus('mc.hypixel.net')
 * await checkServerStatus('play.pixelmon.pro', 'java')
 */
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

        const version = typeof data.version === 'object'
          ? data.version?.name || data.version?.raw || '未知'
          : data.version ?? data.server_version ?? '未知'

        const rawMotd = data.motd?.raw ?? data.motd?.clean ?? data.motd?.html ??
                       data.motd?.ingame ?? data.description ?? data.motd

        const motd = typeof rawMotd === 'object'
          ? parseMOTDJson(rawMotd)
          : typeof rawMotd === 'string'
            ? stripColorCodes(rawMotd)
            : undefined

        const playersOnline = Number(data.players_online ?? data.players?.online ?? data.online)
        const playersMax = Number(data.players_max ?? data.players?.max ?? data.max)

        if ((!version || version === '未知') &&
            (isNaN(playersOnline) || isNaN(playersMax)) &&
            !motd) {
          throw new Error('获取到的数据无效')
        }

        return {
          online: true,
          ip: parsed.host,
          port: parsed.port,
          ip_address: data.ip_address,
          eula_blocked: data.eula_blocked,
          retrieved_at: data.retrieved_at,
          expires_at: data.expires_at,
          version: {
            name: data.version?.name_clean || data.version?.name || '未知',
            name_raw: data.version?.name_raw,
            name_clean: data.version?.name_clean,
            name_html: data.version?.name_html,
            protocol: data.version?.protocol
          },
          players: {
            online: data.players?.online || 0,
            max: data.players?.max || 0,
            list: data.players?.list?.map(p => ({
              uuid: p.uuid,
              name_raw: p.name_raw,
              name_clean: p.name_clean,
              name_html: p.name_html
            }))
          },
          motd: {
            raw: data.motd?.raw,
            clean: data.motd?.clean,
            html: data.motd?.html
          },
          gamemode: data.gamemode,
          server_id: data.server_id,
          edition: data.edition,
          icon: data.icon,
          mods: data.mods,
          software: data.software,
          plugins: data.plugins,
          srv_record: data.srv_record
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

/**
 * 尝试解码文本，支持 UTF-8 和 GBK 编码
 * @param {string} text - 要解码的文本
 * @returns {string} 解码后的文本
 * @private
 */
function decodeText(text: string): string {
  try {
    return decodeURIComponent(escape(text))
  } catch {
    try {
      return new TextDecoder('gbk').decode(new TextEncoder().encode(text))
    } catch {
      return text
    }
  }
}

/**
 * 移除 Minecraft 颜色代码
 * @param {string} text - 包含颜色代码的文本
 * @returns {string} 移除颜色代码后的文本
 * @private
 */
function stripColorCodes(text: string): string {
  const decodedText = decodeText(text)
  return decodedText.replace(/§[0-9a-fk-or]/gi, '')
}

/**
 * 解析 MOTD JSON 对象
 * @param {any} obj - MOTD JSON 对象
 * @returns {string} 解析后的纯文本
 * @private
 */
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

/**
 * 格式化服务器状态信息为可读文本
 * @param {ServerStatus} status - 服务器状态对象
 * @param {MinecraftToolsConfig['info']} config - 信息显示配置
 * @returns {string} 格式化后的状态信息
 * @example
 * const status = await checkServerStatus('mc.hypixel.net')
 * console.log(formatServerStatus(status, config.info))
 */
export function formatServerStatus(status: ServerStatus, config: MinecraftToolsConfig['info']) {
  const lines: string[] = []

  if (!status.online) {
    return `离线 - ${status.error || '无法连接到服务器'}`
  }

  if (config.showIcon && status.icon?.startsWith('data:image/png;base64,')) {
    lines.push(h.image(status.icon).toString())
  }

  if (status.motd?.clean) {
    lines.push(status.motd.clean)
  }

  const statusParts = [
    status.version?.name || '未知',
    `${status.players?.online || 0}/${status.players?.max || 0}`,
  ]
  if (status.retrieved_at) statusParts.push(`延迟: ${Date.now() - status.retrieved_at}ms`)
  lines.push(statusParts.join(' | '))

  if (config.maxPlayerDisplay > 0 && status.players?.list?.length) {
    const displayCount = Math.min(config.maxPlayerDisplay, status.players.list.length)
    const playerNames = status.players.list
      .slice(0, displayCount)
      .map(p => p.name_clean || p.name_raw)
      .join(', ')

    const playerInfo = ['当前在线：' + playerNames]
    if (status.players.online > displayCount) {
      playerInfo.push(`（等共 ${status.players.online} 名）`)
    }
    lines.push(playerInfo.join(''))
  }

  if (status.mods?.length) {
    lines.push('\n模组信息：')
    lines.push(`已安装：${status.mods.length} 个模组`)
    if (config.maxModDisplay > 0) {
      const displayCount = Math.min(config.maxModDisplay, status.mods.length)
      const modList = status.mods
        .slice(0, displayCount)
        .map(mod => mod.version ? `${mod.name} (${mod.version})` : mod.name)
        .join(', ')
      lines.push(`模组列表：${modList}`)
      if (status.mods.length > displayCount) {
        lines.push(`（等共 ${status.mods.length} 个模组）`)
      }
    }
  }

  const additionalInfo = []
  if (status.software) additionalInfo.push(`服务端：${status.software}`)
  if (status.plugins?.length) additionalInfo.push(`插件数：${status.plugins.length}`)
  if (status.srv_record) additionalInfo.push(`SRV记录：${status.srv_record.host}:${status.srv_record.port}`)
  if (status.eula_blocked) additionalInfo.push('已被 EULA 封禁')
  if (status.edition) {
    const editionMap = { MCPE: '基岩版', MCEE: '教育版' }
    additionalInfo.push(`版本类型：${editionMap[status.edition] || status.edition}`)
  }
  if (status.gamemode) additionalInfo.push(`游戏模式：${status.gamemode}`)
  if (status.server_id) additionalInfo.push(`服务器ID：${status.server_id}`)

  if (additionalInfo.length > 0) {
    lines.push('\n服务器信息：')
    lines.push(additionalInfo.join(' | '))
  }

  return lines.join('\n')
}
