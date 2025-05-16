import { Context, h } from 'koishi'
import { Config } from '../index'
import * as net from 'net'
import * as dgram from 'dgram'

/**
 * Minecraft 服务器状态信息接口
 * @interface ServerStatus
 * @property {boolean} online - 服务器是否在线
 * @property {string} host - 服务器主机地址
 * @property {number} port - 服务器端口
 * @property {string|null} [ip_address] - 服务器解析后的 IP 地址
 * @property {boolean} [eula_blocked] - 服务器是否因违反 EULA 被封禁
 * @property {number} [ping] - 延迟时间(毫秒)
 * @property {object} [version] - 服务器版本信息
 * @property {string} [version.name_clean] - 清理过的版本名称
 * @property {string|null} [version.name] - 原始版本名称
 * @property {object} players - 玩家信息
 * @property {number|null} players.online - 在线玩家数量
 * @property {number|null} players.max - 最大玩家数量
 * @property {string[]} [players.list] - 在线玩家列表
 * @property {string} [motd] - 服务器描述信息
 * @property {string|null} [icon] - 服务器图标(Base64)
 * @property {Array<{name: string, version?: string}>} [mods] - 服务器模组列表
 * @property {string|null} [software] - 服务器软件
 * @property {Array<{name: string, version?: string|null}>} [plugins] - 服务器插件列表
 * @property {{host: string, port: number}|null} [srv_record] - SRV 记录信息
 * @property {string|null} [gamemode] - 游戏模式
 * @property {string|null} [server_id] - 服务器唯一标识
 * @property {'MCPE'|'MCEE'|null} [edition] - 服务器版本类型(基岩版/教育版)
 * @property {string} [error] - 错误信息
 */
interface ServerStatus {
  online: boolean
  host: string
  port: number
  ip_address?: string | null
  eula_blocked?: boolean
  ping?: number
  version?: { name_clean?: string, name?: string | null }
  players: { online: number | null, max: number | null, list?: string[] }
  motd?: string
  icon?: string | null
  mods?: { name: string, version?: string }[]
  software?: string | null
  plugins?: { name: string, version?: string | null }[]
  srv_record?: { host: string, port: number } | null
  gamemode?: string | null
  server_id?: string | null
  edition?: 'MCPE' | 'MCEE' | null
  error?: string
}

/**
 * 解析并验证 Minecraft 服务器地址
 * @param {string} input - 输入的服务器地址
 * @returns {string} 验证后的服务器地址
 * @throws {Error} 当地址无效时抛出错误
 */
function validateServerAddress(input: string): string {
  // 检查禁止的本地/内网地址
  const lowerAddr = input.toLowerCase();
  const forbiddenAddresses = ['localhost', '127.0.0.', '0.0.0.0', '::1', '::'];
  if (forbiddenAddresses.some(addr => lowerAddr.includes(addr)) ||
      /^fe80:|^f[cd]|^ff/.test(lowerAddr)) {
    throw new Error('无效地址');
  }
  // 解析端口
  let port: number | undefined;
  if (input.includes(':')) {
    const portMatch = input.match(/\]:(\d+)$/) || input.match(/:(\d+)$/);
    if (portMatch) {
      port = parseInt(portMatch[1], 10);
      if (port < 1 || port > 65535) throw new Error('无效端口');
    }
  }
  // 验证IPv4地址
  if (/^(\d{1,3}\.){3}\d{1,3}/.test(input)) {
    const ipPart = input.split(':')[0];
    const octets = ipPart.split('.').map(Number);
    // 检查内网和特殊IP地址
    const isInvalid =
      octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] > 223 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254);
    if (isInvalid) throw new Error('无效地址');
  }
  return input;
}

/**
 * 直接ping Minecraft服务器
 * @param {string} host - 服务器主机地址
 * @param {number} port - 服务器端口
 * @param {'java'|'bedrock'} type - 服务器类型，java 使用 TCP，bedrock 使用 UDP
 * @param {number} [timeout=3000] - 超时时间(毫秒)
 * @returns {Promise<number>} ping时间(毫秒)
 * @throws {Error} 当连接超时或发生错误时抛出异常
 */
async function pingServer(host: string, port: number, type: 'java' | 'bedrock', timeout = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    if (type === 'java') {
      // Java服务器TCP
      const socket = net.createConnection({ host, port, timeout });
      const cleanup = () => { socket.removeAllListeners(); socket.destroy(); };
      socket.once('connect', () => { cleanup(); resolve(Date.now() - startTime); })
        .once('error', err => { cleanup(); reject(err); })
        .once('timeout', () => { cleanup(); reject(new Error('超时')); });
    } else {
      // 基岩版UDP
      const client = dgram.createSocket('udp4');
      const pingData = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]);
      const timer = setTimeout(() => { client.close(); reject(new Error('超时')); }, timeout);
      const cleanup = () => { clearTimeout(timer); client.removeAllListeners(); client.close(); };
      client.once('message', () => { cleanup(); resolve(Date.now() - startTime); })
        .once('error', err => { cleanup(); reject(err); });
      client.send(pingData, port, host, err => { if (err) { cleanup(); reject(err); } });
    }
  });
}

/**
 * 获取 Minecraft 服务器状态
 * @param {string} server - 服务器地址，可以包含端口(如 example.com:25565)
 * @param {'java'|'bedrock'} forceType - 强制使用的服务器类型，java 或 bedrock
 * @param {Config} [config] - 配置信息，包含API端点等配置
 * @returns {Promise<ServerStatus>} 服务器状态信息对象
 * @description 首先尝试直接ping服务器，然后使用配置的API获取详细信息。
 */
async function fetchServerStatus(server: string, forceType: 'java' | 'bedrock', config?: Config): Promise<ServerStatus> {
  try {
    const address = validateServerAddress(server);
    const serverType = forceType || 'java';
    const defaultPort = serverType === 'java' ? 25565 : 19132;
    const host = address.split(':')[0], port = parseInt(address.split(':')[1]) || defaultPort;
    const apiEndpoints = config?.serverApis?.filter(api => api.type === serverType)?.map(api => api.url) || [];
    const errors = [];
    let directPing: number | null = null;
    try { directPing = await pingServer(host, port, serverType, 3000); } catch (e) {}
    // API查询
    for (const apiUrl of apiEndpoints) {
      try {
        const requestUrl = apiUrl.replace('${address}', address);
        const startTime = Date.now();
        const response = await fetch(requestUrl, {headers: {'User-Agent': 'Mozilla/5.0'}, method: 'GET'});
        if (response.ok) {
          const data = await response.json();
          const result = normalizeApiResponse(data, address, serverType);
          result.ping = directPing || data.ping || (Date.now() - startTime);
          return result;
        }
        errors.push(`${apiUrl.split('/').pop()} ${response.status}`);
      } catch (e) { errors.push(`API错误`); }
    }
    if (directPing !== null) return { online: true, host, port, ping: directPing, players: { online: null, max: null } };
    return {
      online: false, host, port,
      players: { online: null, max: null },
      error: errors.length ? `请求失败: ${errors[0]}` : '服务器无响应'
    };
  } catch (error) {
    return {
      online: false, host: server, port: forceType === 'bedrock' ? 19132 : 25565,
      players: { online: null, max: null }, error: `地址错误: ${error.message}`
    };
  }
}

/**
 * 标准化 API 响应格式，自动猜测可能的格式
 * @param {any} data - API 响应的原始数据
 * @param {string} address - 服务器地址
 * @param {'java'|'bedrock'} serverType - 服务器类型
 * @returns {ServerStatus} 标准化后的服务器状态
 */
function normalizeApiResponse(data: any, address: string, serverType: 'java' | 'bedrock'): ServerStatus {
  // 检查服务器是否在线
  if (data.online === false || (data.status === 'error' && !data.players) ||
      (data.status === 'offline') || (typeof data.status === 'string' && data.status.toLowerCase() === 'offline')) {
    return {
      online: false,
      host: data.hostname || data.host || data.ip || address.split(':')[0],
      port: data.port || parseInt(address.split(':')[1]) || (serverType === 'java' ? 25565 : 19132),
      players: { online: null, max: null },
      error: data.error || data.description
    };
  }
  // 统一处理各种 API 格式
  return {
    online: true,
    host: data.hostname || data.host || data.server || address.split(':')[0],
    port: data.port || data.ipv6Port || parseInt(address.split(':')[1]) || (serverType === 'java' ? 25565 : 19132),
    ip_address: data.ip_address || data.ip || data.hostip,
    eula_blocked: data.eula_blocked || data.blocked,
    version: {
      name_clean: data.version?.name_clean || data.version || data.server?.version || data.server_version,
      name: data.version?.name || data.protocol?.name || data.version?.protocol_name
    },
    players: {
      online: data.players?.online ?? data.players?.now ?? data.players_online ?? data.online_players ?? 0,
      max: data.players?.max ?? data.players_max ?? data.max_players ?? 0,
      list: Array.isArray(data.players?.list)
        ? data.players.list.map(p => typeof p === 'string' ? p : p.name || p.name_clean || p.id)
        : (Array.isArray(data.players)
           ? data.players.map(p => typeof p === 'string' ? p : p.name || p.name_clean || p.id)
           : data.players?.sample?.map(p => p.name) || data.player_list)
    },
    motd: data.motd?.clean?.[0] || (Array.isArray(data.motd?.clean) ? data.motd.clean[0] : null) ||
          data.motd?.raw?.[0] || data.motd || data.description?.text || data.description || data.server_motd,
    icon: data.icon || data.favicon || data.favocion,
    mods: (data.mods && (Array.isArray(data.mods)
           ? data.mods.map(m => typeof m === 'string' ? { name: m } : m)
           : Object.entries(data.mods).map(([k, v]) => ({ name: k, version: v }))))
           || data.modinfo?.modList?.map(m => ({ name: m.modid, version: m.version }))
           || (data.modInfo ? { name: data.modInfo } : null)
           || data.modlist,
    software: data.software || data.server?.name || data.server_software,
    plugins: (data.plugins && (Array.isArray(data.plugins)
              ? data.plugins.map(p => typeof p === 'string' ? { name: p } : p)
              : Object.entries(data.plugins).map(([k, v]) => ({ name: k, version: v }))))
              || data.plugin_list,
    srv_record: data.srv_record || data.srv,
    gamemode: data.gamemode || data.game_type || data.gametype,
    server_id: data.server_id || data.serverid || data.uuid || data.serverId,
    edition: data.edition || (serverType === 'bedrock' ? 'MCPE' : null) || (data.platform === 'MINECRAFT_BEDROCK' ? 'MCPE' : null)
  };
}

/**
 * 格式化服务器状态信息
 * @param {ServerStatus} status - 服务器状态对象
 * @param {Config} config - 配置信息
 * @returns {string} 格式化后的服务器状态文本
 */
function formatServerStatus(status: ServerStatus, config: Config) {
  if (!status.online) return status.error || '服务器离线 - 连接失败';
  const getValue = (name: string, limit?: number) => {
    switch (name) {
      case 'name': return `${status.host}:${status.port}`;
      case 'ip': return status.ip_address;
      case 'srv': return status.srv_record && `${status.srv_record.host}:${status.srv_record.port}`;
      case 'icon': return status.icon?.startsWith('data:image/png;base64,') ? h.image(status.icon).toString() : null;
      case 'motd': return status.motd;
      case 'version': return status.version?.name_clean;
      case 'online': return status.players.online != null ? String(status.players.online) : null;
      case 'max': return status.players.max != null ? String(status.players.max) : null;
      case 'ping': return status.ping ? `${status.ping}ms` : null;
      case 'software': return status.software;
      case 'edition': return status.edition && ({ MCPE: '基岩版', MCEE: '教育版' }[status.edition] || status.edition);
      case 'gamemode': return status.gamemode;
      case 'eulablock': return status.eula_blocked ? '已被封禁' : null;
      case 'serverid': return status.server_id;
      case 'playercount': return String(status.players.list?.length || 0);
      case 'plugincount': return String(status.plugins?.length || 0);
      case 'modcount': return String(status.mods?.length || 0);
      case 'playerlist':
        if (!status.players.list?.length) return null;
        limit = limit || status.players.list.length;
        return status.players.list.slice(0, limit)
          .map(p => p)
          .join(', ') + (limit < status.players.list.length ? '...' : '');
      case 'pluginlist':
        if (!status.plugins?.length) return null;
        limit = limit || status.plugins.length;
        return status.plugins.slice(0, limit)
          .map(p => p.version ? `${p.name}-${p.version}` : p.name)
          .join(', ') + (limit < status.plugins.length ? '...' : '');
      case 'modlist':
        if (!status.mods?.length) return null;
        limit = limit || status.mods.length;
        return status.mods.slice(0, limit)
          .map(m => m.version ? `${m.name}-${m.version}` : m.name)
          .join(', ') + (limit < status.mods.length ? '...' : '');
      default: return null;
    }
  };
  // 处理模板
  const results = config.serverTemplate.split('\n')
    .map(line => {
      const placeholders = Array.from(line.matchAll(/\{([^{}:]+)(?::(\d+))?\}/g));
      if (placeholders.some(match => {
        const name = match[1];
        const limit = match[2] ? parseInt(match[2], 10) : undefined;
        const value = getValue(name, limit);
        return value === null || value === undefined || value === '';
      })) return '';
      // 替换占位符
      return line.replace(/\{([^{}:]+)(?::(\d+))?\}/g, (match, name, limitStr) => {
        const limit = limitStr ? parseInt(limitStr, 10) : undefined;
        const value = getValue(name, limit);
        return value !== null && value !== undefined ? value : '';
      });
    })
    .filter(line => line.trim()).join('\n');
  return results.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 根据会话查找群组对应的服务器
 * @param {any} session - 会话对象
 * @param {Config} config - 配置信息
 * @returns {{server: string, serverId: number}|{error: string}} 服务器信息或错误信息
 */
function findGroupServer(session: any, config: Config): { server: string, serverId: number } | { error: string } {
  const mapping = config.serverMaps.find(m =>m.platform === session.platform && m.channelId === session.guildId);
  if (!mapping) return { error: '请提供服务器地址' };
  if (!mapping.serverAddress) return { error: `服务器 #${mapping.serverId} 未配置地址` };
  return { server: mapping.serverAddress, serverId: mapping.serverId };
}

/**
 * 注册服务器信息命令
 * @param {Context} ctx - Koishi 上下文
 * @param {any} parent - 父命令
 * @param {Config} config - 插件配置
 */
export function registerInfo(ctx: Context, parent: any, config: Config) {
  const mcinfo = parent.subcommand('.info [server]', '查询 Minecraft 服务器')
    .usage(`mc.info [地址[:端口]] - 查询 Java 服务器\nmc.info.be [地址[:端口]] - 查询 Bedrock 服务器`)
    .action(async ({ session }, server) => {
      try {
        if (!server && session) {
          const groupServer = findGroupServer(session, config);
          if ('error' in groupServer) return groupServer.error;
          server = groupServer.server;
          return fetchServerStatus(server, 'java', config).then(status => formatServerStatus(status, config));
        }
        const status = await fetchServerStatus(server, 'java', config);
        return formatServerStatus(status, config);
      } catch (error) {
        ctx.logger.error(`Java 服务器查询失败: ${error.message}`, error);
        return `信息查询失败`;
      }
    });
  mcinfo.subcommand('.be [server]', '查询 Bedrock 服务器')
    .action(async ({ session }, server) => {
      try {
        if (!server && session) {
          const groupServer = findGroupServer(session, config);
          if ('error' in groupServer) return groupServer.error;
          server = groupServer.server;
          return fetchServerStatus(server, 'bedrock', config).then(status => formatServerStatus(status, config));
        }
        const status = await fetchServerStatus(server, 'bedrock', config);
        return formatServerStatus(status, config);
      } catch (error) {
        ctx.logger.error(`Bedrock 服务器查询失败: ${error.message}`, error);
        return `信息查询失败`;
      }
    });
}