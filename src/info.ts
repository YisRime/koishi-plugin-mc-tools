import { h } from 'koishi'
import axios from 'axios'
import { MinecraftToolsConfig } from './index'

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
  const address = input || defaultServer

  try {
    let host: string, port: number | undefined
    // 处理IPv6地址格式 [xxxx:xxxx::xxxx]:port
    if (address.includes('[')) {
      const match = address.match(/^\[([\da-fA-F:]+)\](?::(\d+))?$/)
      if (!match) throw new Error('无效的IPv6地址格式')

      host = match[1]
      port = match[2] ? parseInt(match[2], 10) : undefined
    }
    // 处理带端口的地址 host:port
    else if (address.includes(':')) {
      const parts = address.split(':')
      host = parts[0]
      port = parseInt(parts[1], 10)
    }
    // 处理不带端口的地址
    else {
      host = address
    }
    // 安全检查
    if (host.toLowerCase() === 'localhost') {
      throw new Error('不允许连接到本地服务器')
    }
    // IPv4地址检查
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
      const parts = host.split('.').map(Number)
      // 验证格式和检查私有地址
      if (!parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
        throw new Error('无效的IPv4地址格式')
      }
      if (parts[0] === 127 || parts[0] === 10 ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 169 && parts[1] === 254) ||
          parts[0] >= 224 || parts[0] === 0) {
        throw new Error('不允许连接到私有网络地址')
      }
    }
    // IPv6地址检查
    else if (/^[0-9a-fA-F:]+$/.test(host)) {
      const lowerIP = host.toLowerCase()
      const segments = host.split(':')
      const doubleColonIndex = host.indexOf('::')
      // 检查格式和私有地址
      if ((doubleColonIndex !== -1 && host.indexOf('::', doubleColonIndex + 1) !== -1) ||
          (doubleColonIndex === -1 && segments.length !== 8) ||
          !segments.every(segment => segment === '' || /^[0-9a-fA-F]{1,4}$/.test(segment))) {
        throw new Error('无效的IPv6地址格式')
      }
      if (lowerIP === '::1' || lowerIP === '0:0:0:0:0:0:0:1' ||
          /^fe80:/i.test(lowerIP) || /^f[cd][0-9a-f]{2}:/i.test(lowerIP) ||
          lowerIP.startsWith('ff')) {
        throw new Error('不允许连接到私有网络地址')
      }
    }
    // 域名格式检查
    else if (!(host.length > 0 &&
               host.length <= 253 &&
               !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
               /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/.test(host))) {
      throw new Error('无效的域名格式')
    }
    // 验证端口
    if (port !== undefined && (isNaN(port) || port < 1 || port > 65535)) {
      throw new Error('端口号必须在1-65535之间')
    }
    // 根据端口判断服务器类型
    const type = (port === 19132 || address.endsWith(':19132')) ? 'bedrock' : 'java'
    return { address, type }
  }
  catch (error) {
    throw new Error(`地址格式错误：${error.message}`)
  }
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
          headers: { 'User-Agent': 'koishi-plugin-mc-tools/1.0' },
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
            online: data.players?.online ?? null,
            max: data.players?.max ?? null,
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
      online: data.players?.online ?? 0,
      max: data.players?.max ?? 0,
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
  if (!status.online) {
    return `服务器离线 - ${status.error || '连接失败'}`
  }

  const lines: string[] = []

  // 添加 IP 信息
  if (config.showIP) {
    status.ip_address && lines.push(`IP: ${status.ip_address}`)
    status.srv_record && lines.push(`SRV: ${status.srv_record.host}:${status.srv_record.port}`)
  }

  // 添加图标和 MOTD
  status.icon?.startsWith('data:image/png;base64,') && config.showIcon && lines.push(h.image(status.icon).toString())
  status.motd && lines.push(status.motd)

  // 添加基本状态信息
  const statusParts = [
    status.version?.name_clean || '未知',
    `${status.players?.online ?? 0}/${status.players?.max ?? 0}`,
  ]
  status.retrieved_at && statusParts.push(`${Date.now() - status.retrieved_at}ms`)
  lines.push(statusParts.join(' | '))

  // 添加服务器信息
  const serverInfo = []
  status.software && serverInfo.push(status.software)

  if (status.edition) {
    const editionMap = { MCPE: '基岩版', MCEE: '教育版' }
    serverInfo.push(editionMap[status.edition] || status.edition)
  }

  status.gamemode && serverInfo.push(status.gamemode)
  status.eula_blocked && serverInfo.push('已被封禁')
  status.server_id && serverInfo.push(`ID: ${status.server_id}`)
  serverInfo.length > 0 && lines.push(serverInfo.join(' | '))

  // 添加玩家列表
  const hasPlayers = status.players?.list?.length && config.maxNumberDisplay > 0
  if (hasPlayers) {
    const displayCount = Math.min(config.maxNumberDisplay, status.players.list.length)
    lines.push(`当前在线(${status.players.online}):`)
    const playerList = status.players.list.slice(0, displayCount).join(', ')
    lines.push(playerList + (status.players.list.length > displayCount ? ' ...' : ''))
  }

  // 添加插件列表
  const hasPlugins = status.plugins?.length && config.maxNumberDisplay > 0
  if (hasPlugins) {
    const displayCount = Math.min(config.maxNumberDisplay, status.plugins.length)
    lines.push(`插件(${status.plugins.length}):`)
    const pluginList = status.plugins
      .slice(0, displayCount)
      .map(p => p.version ? `${p.name}-${p.version}` : p.name)
      .join(', ')
    lines.push(pluginList + (status.plugins.length > displayCount ? ' ...' : ''))
  }

  // 添加模组列表
  const hasMods = status.mods?.length && config.maxNumberDisplay > 0
  if (hasMods) {
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

/**
 * 注册 Minecraft 服务器信息查询命令
 * @param {Context} ctx - Koishi 上下文
 * @param {Command} parent - 父命令
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function registerInfoCommands(parent: any, config: MinecraftToolsConfig) {
  const mcinfo = parent.subcommand('.info [server]', '查询 Minecraft 服务器信息')
    .usage(`mc.info [地址[:端口]] - 查询 Java 版服务器\nmc.info.be [地址[:端口]] - 查询 Bedrock 版服务器`)
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || config.info.default, 'java', config)
        return formatServerStatus(status, config.info)
      } catch (error) {
        return error.message
      }
    })

  mcinfo.subcommand('.be [server]', '查询 Bedrock 版服务器')
    .usage('mc.info.be [地址[:端口]] - 查询 Bedrock 版服务器状态')
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || config.info.default, 'bedrock', config)
        return formatServerStatus(status, config.info)
      } catch (error) {
        return error.message
      }
    })
}
