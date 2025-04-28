import { Context, h } from 'koishi'
import axios from 'axios'
import { MTConfig } from './index'

interface ServerStatus {
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
 */
function validateServerAddress(
  input?: string,
  defaultServer?: string
): { address: string, type: 'java' | 'bedrock' } {
  const address = input || defaultServer
  try {
    let host: string, port: number | undefined
    // IPv6地址格式
    if (address.includes('[')) {
      const match = address.match(/^\[([\da-fA-F:]+)\](?::(\d+))?$/)
      if (!match) throw new Error('无效的IPv6地址格式')
      host = match[1]
      port = match[2] ? parseInt(match[2], 10) : undefined
    }
    // 带端口地址
    else if (address.includes(':')) {
      const [hostPart, portPart] = address.split(':')
      host = hostPart
      port = parseInt(portPart, 10)
    }
    // 不带端口地址
    else {
      host = address
    }

    // 安全检查
    if (['localhost', '0.0.0.0'].includes(host.toLowerCase())) {
      throw new Error('不允许连接到本地服务器')
    }

    // IPv4地址检查
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
      const parts = host.split('.').map(Number)
      if (!parts.every(p => p >= 0 && p <= 255)) {
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
      if (lowerIP === '::1' || lowerIP === '0:0:0:0:0:0:0:1' ||
          /^fe80:/i.test(lowerIP) || /^f[cd][0-9a-f]{2}:/i.test(lowerIP) ||
          lowerIP.startsWith('ff') || lowerIP === '::') {
        throw new Error('不允许连接到私有网络地址')
      }
    }

    // 验证端口
    if (port !== undefined && (isNaN(port) || port < 1 || port > 65535)) {
      throw new Error('端口号必须在1-65535之间')
    }

    // 判断服务器类型
    const type = (port === 19132 || address.endsWith(':19132')) ? 'bedrock' : 'java'
    return { address, type }
  }
  catch (error) {
    throw new Error(`地址格式错误：${error.message}`)
  }
}

/**
 * 获取 Minecraft 服务器状态
 */
async function fetchServerStatus(
  server?: string,
  forceType?: 'java' | 'bedrock',
  config?: MTConfig
): Promise<ServerStatus> {
  try {
    const parsed = validateServerAddress(server, config?.default)
    const serverType = forceType || parsed.type
    const apiEndpoints = serverType === 'java' ? config?.javaApis : config?.bedrockApis

    if (!apiEndpoints?.length) {
      throw new Error(`缺少 ${serverType} 版本查询 API 配置`)
    }

    const errors: string[] = []
    for (const apiUrl of apiEndpoints) {
      const requestUrl = apiUrl.replace('${address}', parsed.address)
      try {
        const response = await axios.get(requestUrl, {
          headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
          timeout: 10000,
          validateStatus: null
        })

        if (!response.data || response.status !== 200) {
          errors.push(`${requestUrl} 请求失败: ${response.data?.error || response.status}`)
          continue
        }

        // 特殊处理 mcsrvstat.us API
        if (requestUrl.includes('mcsrvstat.us')) {
          return await normalizeMcsrvstatResponse(response.data)
        }

        const data = response.data
        if (!data.online) {
          errors.push(`${requestUrl} 返回服务器离线`)
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
        errors.push(`${requestUrl} 连接错误: ${error.message}`)
      }
    }

    return {
      online: false,
      host: parsed.address,
      port: parseInt(parsed.address.split(':')[1]) || (serverType === 'java' ? 25565 : 19132),
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

/**
 * 标准化 mcsrvstat.us API 响应格式
 */
async function normalizeMcsrvstatResponse(data: any): Promise<ServerStatus> {
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
 * 格式化服务器状态信息
 */
function formatServerStatus(status: ServerStatus, config: MTConfig) {
  if (!status.online) {
    return status.error || '服务器离线 - 连接失败'
  }

  const infoLines: string[] = []

  // IP 信息
  config.showIP && status.ip_address && infoLines.push(`IP: ${status.ip_address}`)
  config.showIP && status.srv_record && infoLines.push(`SRV: ${status.srv_record.host}:${status.srv_record.port}`)

  // 图标和 MOTD
  status.icon?.startsWith('data:image/png;base64,') && config.showIcon && infoLines.push(h.image(status.icon).toString())
  status.motd && infoLines.push(status.motd)

  // 基本状态
  infoLines.push([
    status.version?.name_clean || '未知',
    `${status.players?.online ?? 0}/${status.players?.max ?? 0}`,
    status.retrieved_at && `${Date.now() - status.retrieved_at}ms`
  ].filter(Boolean).join(' | '))

  // 服务器信息
  const serverInfo = []
  status.software && serverInfo.push(status.software)
  if (status.edition) {
    const editionMap = { MCPE: '基岩版', MCEE: '教育版' }
    serverInfo.push(editionMap[status.edition] || status.edition)
  }
  status.gamemode && serverInfo.push(status.gamemode)
  status.eula_blocked && serverInfo.push('已被封禁')
  status.server_id && serverInfo.push(`ID: ${status.server_id}`)
  serverInfo.length > 0 && infoLines.push(serverInfo.join(' | '))

  // 玩家列表
  if (status.players?.list?.length && config.maxNumber !== 0) {
    const showAll = config.maxNumber < 0;
    const displayCount = showAll ? status.players.list.length : Math.min(config.maxNumber, status.players.list.length);
    infoLines.push(`当前在线(${status.players.online}):`)
    infoLines.push(status.players.list.slice(0, displayCount).join(', ') +
               (!showAll && status.players.list.length > displayCount ? ' ...' : ''))
  }

  // 插件列表
  if (status.plugins?.length && config.maxNumber !== 0) {
    const showAll = config.maxNumber < 0;
    const displayCount = showAll ? status.plugins.length : Math.min(config.maxNumber, status.plugins.length);
    infoLines.push(`插件(${status.plugins.length}):`)
    infoLines.push(status.plugins
      .slice(0, displayCount)
      .map(p => p.version ? `${p.name}-${p.version}` : p.name)
      .join(', ') + (!showAll && status.plugins.length > displayCount ? ' ...' : ''))
  }

  // 模组列表
  if (status.mods?.length && config.maxNumber !== 0) {
    const showAll = config.maxNumber < 0;
    const displayCount = showAll ? status.mods.length : Math.min(config.maxNumber, status.mods.length);
    infoLines.push(`模组(${status.mods.length}):`)
    infoLines.push(status.mods
      .slice(0, displayCount)
      .map(mod => mod.version ? `${mod.name}-${mod.version}` : mod.name)
      .join(', ') + (!showAll && status.mods.length > displayCount ? ' ...' : ''))
  }

  return infoLines.join('\n')
}

/**
 * 注册服务器信息命令
 */
export function registerInfo(ctx: Context, parent: any, config: MTConfig) {
  const mcinfo = parent.subcommand('.info [server]', '查询 Minecraft 服务器信息')
    .usage(`mc.info [地址[:端口]] - 查询 Java 版服务器\nmc.info.be [地址[:端口]] - 查询 Bedrock 版服务器`)
    .action(async ({}, server) => {
      try {
        const status = await fetchServerStatus(server || config.default, 'java', config)
        return formatServerStatus(status, config)
      } catch (error) {
        return error.message
      }
    })

  mcinfo.subcommand('.be [server]', '查询 Bedrock 版服务器')
    .action(async ({}, server) => {
      try {
        const status = await fetchServerStatus(server || config.default, 'bedrock', config)
        return formatServerStatus(status, config)
      } catch (error) {
        return error.message
      }
    })
}