import { h } from 'koishi'
import { MinecraftToolsConfig } from './index'
import axios from 'axios'

/**
 * 表示 Minecraft 服务器状态的接口
 * @interface ServerStatus
 */
export interface ServerStatus {
  online: boolean
  host: string
  port: number
  ip_address?: string | null
  eula_blocked?: boolean
  retrieved_at?: number
  version?: {
    name_clean?: string
    name?: string | null
  }
  players: {
    online: number | null
    max: number | null
    list?: string[]
  }
  motd?: string
  icon?: string | null
  mods?: {
    name: string
    version?: string
  }[]
  software?: string | null
  plugins?: {
    name: string
    version?: string | null
  }[]
  srv_record?: {
    host: string
    port: number
  } | null
  gamemode?: string | null
  server_id?: string | null
  edition?: 'MCPE' | 'MCEE' | null
  error?: string
}

/**
 * 解析并验证 Minecraft 服务器地址
 * @param {string} [input] - 输入的服务器地址
 * @param {string} [defaultServer] - 默认服务器地址
 * @returns {{ address: string, type: 'java' | 'bedrock' }} 解析后的服务器信息
 * @throws {Error} 当输入的地址格式无效或安全检查失败时抛出错误
 */
function parseServerAddress(
  input?: string,
  defaultServer?: string
): { address: string, type: 'java' | 'bedrock' } {
  const address = input || defaultServer || 'localhost'
  if (address.toLowerCase() === 'localhost') {
    throw new Error('安全限制：不允许连接到 localhost')
  }
  try {
    let host: string, port: number | undefined
    if (address.includes('[')) {
      const match = address.match(/^\[([\da-fA-F:]+)\](?::(\d+))?$/)
      if (!match) throw new Error('IPv6 地址格式不正确')
      host = match[1]
      port = match[2] ? parseInt(match[2], 10) : undefined
      validateIPAddress(host, 'IPv6')
    }
    else if (address.includes(':')) {
      const parts = address.split(':')
      host = parts[0]
      port = parseInt(parts[1], 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('端口号必须在 1-65535 之间')
      }
      validateHost(host)
    }
    else {
      host = address
      validateHost(host)
    }
    const type = address.includes(':19132') ? 'bedrock' : 'java'
    return { address, type }
  }
  catch (error) {
    throw new Error(`地址格式错误：${error.message}`)
  }
}

/**
 * 验证主机名或IP地址
 * @param {string} host - 要验证的主机
 * @throws {Error} 当主机格式不正确或为私有地址时抛出错误
 */
function validateHost(host: string): void {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    validateIPAddress(host, 'IPv4')
  }
  else if (!isValidDomain(host)) {
    throw new Error('无效的域名格式')
  }
}

/**
 * 统一验证 IP 地址格式并检查是否为私有地址
 * @param {string} ip - IP 地址
 * @param {'IPv4' | 'IPv6'} type - IP 地址类型
 * @throws {Error} 当 IP 格式不正确或为私有地址时抛出错误
 */
function validateIPAddress(ip: string, type: 'IPv4' | 'IPv6'): void {
  if (type === 'IPv4') {
    const parts = ip.split('.').map(Number)
    // 检查每个部分是否为有效的 0-255 范围
    if (!parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
      throw new Error('无效的 IPv4 地址')
    }
    // 检查是否为私有 IPv4 地址
    if (isPrivateIPv4(parts)) {
      throw new Error('安全限制：不允许连接到私有 IPv4 地址')
    }
  }
  else {
    // IPv6 格式验证
    if (!isValidIPv6Format(ip)) {
      throw new Error('无效的 IPv6 地址格式')
    }
    // 检查是否为私有 IPv6 地址
    if (isPrivateIPv6(ip)) {
      throw new Error('安全限制：不允许连接到私有 IPv6 地址')
    }
  }
}

/**
 * 检查 IPv4 地址是否为私有地址
 * @param {number[]} parts - IPv4 地址的四个部分
 * @returns {boolean} 是否为私有地址
 */
function isPrivateIPv4(parts: number[]): boolean {
  return (
    parts[0] === 127 || // 本地回环地址: 127.0.0.0/8
    parts[0] === 10 || // 私有网络: 10.0.0.0/8
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // 私有网络: 172.16.0.0/12
    (parts[0] === 192 && parts[1] === 168) || // 私有网络: 192.168.0.0/16
    (parts[0] === 169 && parts[1] === 254) || // 链路本地地址: 169.254.0.0/16
    parts[0] >= 224 || // 组播地址和保留地址: 224.0.0.0/3
    parts[0] === 0 // 0.0.0.0/8
  )
}

/**
 * 检查 IPv6 格式是否有效
 * @param {string} ip - IPv6 地址
 * @returns {boolean} 格式是否有效
 */
function isValidIPv6Format(ip: string): boolean {
  try {
    if (!/^[0-9a-fA-F:]+$/.test(ip)) return false
    const segments = ip.split(':')
    // 检查缩写格式 (::)
    const doubleColonIndex = ip.indexOf('::')
    if (doubleColonIndex !== -1) {
      if (ip.indexOf('::', doubleColonIndex + 1) !== -1) {
        return false
      }
      // 计算省略的零段数量
      const actualSegments = segments.filter(Boolean).length
      if (actualSegments > 7) return false
    }
    else if (segments.length !== 8) {
      return false
    }
    // 检查每个段的值
    return segments.every(segment => {
      return segment === '' || /^[0-9a-fA-F]{1,4}$/.test(segment)
    })
  } catch (error) {
    return false
  }
}

/**
 * 检查 IPv6 地址是否为私有地址
 * @param {string} ip - IPv6 地址
 * @returns {boolean} 是否为私有地址
 */
function isPrivateIPv6(ip: string): boolean {
  const lowerIP = ip.toLowerCase()
  return (
    lowerIP === '::1' ||
    lowerIP === '0:0:0:0:0:0:0:1' ||
    /^::1\/\d+$/.test(lowerIP) ||
    /^f[cd][0-9a-f]{2}:/i.test(lowerIP) || // ULA 地址 fc00::/7
    /^fe[89ab][0-9a-f]:/i.test(lowerIP) || // 链路本地地址 fe80::/10
    lowerIP.startsWith('ff') // 组播地址 ff00::/8
  )
}

/**
 * 验证域名格式是否正确
 * @param {string} domain - 域名
 * @returns {boolean} 是否为有效域名
 */
function isValidDomain(domain: string): boolean {
  return (
    domain.length > 0 &&
    domain.length <= 253 &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(domain) &&
    /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/.test(domain)
  )
}

/**
 * 检查 Minecraft 服务器状态
 * @param {string} [server] - 服务器地址
 * @param {'java' | 'bedrock'} [forceType] - 强制指定服务器类型
 * @param {MinecraftToolsConfig} [config] - 配置选项
 * @returns {Promise<ServerStatus>} 服务器状态信息
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
      throw new Error(`缺少 ${type} 版本查询 API 配置`)
    }

    const errors: string[] = []
    for (const apiUrl of apis) {
      const actualUrl = apiUrl.replace('${address}', parsed.address)
      try {
        const response = await axios.get(actualUrl, {
          headers: {
            'User-Agent': 'koishi-plugin-mc-tools/1.0'
          },
          timeout: 10000,
          validateStatus: null
        })

        if (!response.data || response.status !== 200) {
          errors.push(`${actualUrl} 请求失败: ${response.data?.error || response.status}`)
          continue
        }

        if (actualUrl.includes('mcsrvstat.us')) {
          return await transformMcsrvstatResponse(response.data)
        }

        const data = response.data
        if (!data.online) {
          errors.push(`${actualUrl} 返回服务器离线`)
          continue
        }

        return {
          online: true,
          host: data.host,
          port: data.port,
          ip_address: data.ip_address,
          eula_blocked: data.eula_blocked,
          retrieved_at: data.retrieved_at,
          version: {
            name_clean: data.version?.name_clean,
            name: data.version?.name
          },
          players: {
            online: data.players?.online || null,
            max: data.players?.max || null,
            list: data.players?.list?.map(p => p.name_clean)
          },
          motd: data.motd?.clean,
          icon: data.icon,
          mods: data.mods,
          software: data.software,
          plugins: data.plugins,
          srv_record: data.srv_record,
          gamemode: data.gamemode,
          server_id: data.server_id,
          edition: data.edition
        }
      } catch (error) {
        errors.push(`${actualUrl} 连接错误: ${error.message}`)
      }
    }

    return {
      online: false,
      host: parsed.address,
      port: parseInt(parsed.address.split(':')[1]) || (type === 'java' ? 25565 : 19132),
      players: { online: null, max: null },
      error: `所有 API 均请求失败:\n${errors.join('\n')}`
    }
  } catch (error) {
    return {
      online: false,
      host: server || '未知',
      port: 0,
      players: { online: null, max: null },
      error: error.message || '服务器地址解析失败'
    }
  }
}

async function transformMcsrvstatResponse(data: any): Promise<ServerStatus> {
  if (!data.online) {
    return {
      online: false,
      host: data.hostname || data.ip || 'unknown',
      port: data.port || 0,
      players: { online: null, max: null }
    }
  }

  return {
    online: true,
    host: data.hostname || data.ip,
    port: data.port,
    ip_address: data.ip,
    retrieved_at: data.debug?.cachetime * 1000,
    version: {
      name_clean: data.version,
      name: data.protocol?.name
    },
    players: {
      online: data.players?.online || 0,
      max: data.players?.max || 0,
      list: data.players?.list?.map(p => p.name)
    },
    motd: data.motd?.clean?.[0] || data.motd?.raw?.[0],
    icon: data.icon,
    mods: data.mods,
    software: data.software,
    plugins: data.plugins,
    gamemode: data.gamemode,
    server_id: data.serverid,
    eula_blocked: data.eula_blocked
  }
}

/**
 * 格式化服务器状态信息为可读文本
 * @param {ServerStatus} status - 服务器状态对象
 * @param {MinecraftToolsConfig['info']} config - 信息显示配置
 * @returns {string} 格式化后的状态信息
 */
export function formatServerStatus(status: ServerStatus, config: MinecraftToolsConfig['info']) {
  const lines: string[] = []

  if (!status.online) {
    return `服务器离线 - ${status.error || '连接失败'}`
  }

  if (config.showIP) {
    if (status.ip_address) lines.push(`IP: ${status.ip_address}`)
    if (status.srv_record) lines.push(`SRV: ${status.srv_record.host}:${status.srv_record.port}`)
  }

  if (config.showIcon && status.icon?.startsWith('data:image/png;base64,')) {
    lines.push(h.image(status.icon).toString())
  }
  if (status.motd) {
    lines.push(status.motd)
  }

  const statusParts = [
    status.version?.name_clean || '未知',
    `${status.players?.online || 0}/${status.players?.max || 0}`,
  ]
  if (status.retrieved_at) statusParts.push(`${Date.now() - status.retrieved_at}ms`)
  lines.push(statusParts.join(' | '))

  const serverInfo = []
  if (status.software) serverInfo.push(status.software)
  if (status.edition) {
    const editionMap = { MCPE: '基岩版', MCEE: '教育版' }
    serverInfo.push(editionMap[status.edition] || status.edition)
  }
  if (status.gamemode) serverInfo.push(status.gamemode)
  if (status.eula_blocked) serverInfo.push('已被封禁')
  if (status.server_id) serverInfo.push(`ID: ${status.server_id}`)
  if (serverInfo.length > 0) {
    lines.push(serverInfo.join(' | '))
  }

  if (status.players?.list?.length && config.maxNumberDisplay > 0) {
    const displayCount = Math.min(config.maxNumberDisplay, status.players.list.length)
    lines.push(`当前在线(${status.players.online}):`)
    const playerList = status.players.list.slice(0, displayCount).join(', ')
    lines.push(playerList + (status.players.list.length > displayCount ? ' ...' : ''))
  }

  if (status.plugins?.length && config.maxNumberDisplay > 0) {
    const displayCount = Math.min(config.maxNumberDisplay, status.plugins.length)
    lines.push(`插件(${status.plugins.length}):`)
    const pluginList = status.plugins
      .slice(0, displayCount)
      .map(p => p.version ? `${p.name}-${p.version}` : p.name)
      .join(', ')
    lines.push(pluginList + (status.plugins.length > displayCount ? ' ...' : ''))
  }

  if (status.mods?.length && config.maxNumberDisplay > 0) {
    const displayCount = Math.min(config.maxNumberDisplay, status.mods.length)
    lines.push(`模组(${status.mods.length}):`)
    const modList = status.mods
      .slice(0, displayCount)
      .map(mod => mod.version ? `${mod.name}-${mod.version}` : mod.name)
      .join(', ')
    lines.push(modList + (status.mods.length > displayCount ? ' ...' : ''))
  }

  return lines.join('\n')
}
