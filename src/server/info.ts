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
function validateServerAddress(input: string): string | null {
  const lowerAddr = input.toLowerCase();
  if (/^(\[::\]|::)(:\d+)?$/.test(lowerAddr) || /^(\[::1\]|::1)(:\d+)?$/.test(lowerAddr)) return null;
  const forbiddenPatterns = ['localhost', '127.0.0.', '0.0.0.0'];
  if (forbiddenPatterns.some(pattern => lowerAddr.includes(pattern))) return null;
  let hostPart = input;
  let portStr: string | undefined;
  const ipv6Match = input.match(/^\[(.+)\](?::(\d+))?$/);
  if (ipv6Match) {
    hostPart = ipv6Match[1];
    portStr = ipv6Match[2];
  } else {
    const lastColon = input.lastIndexOf(':');
    if (lastColon > -1 && input.indexOf(':') === lastColon) {
      hostPart = input.substring(0, lastColon);
      portStr = input.substring(lastColon + 1);
    }
  }
  if (portStr) {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) return null;
  }
  const lowerHost = hostPart.toLowerCase();
  if (/^fe80:|^f[cd]|^ff/.test(lowerHost)) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}/.test(hostPart)) {
    const octets = hostPart.split('.').map(Number);
    const isInvalid =
      octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] > 223 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254);
    if (isInvalid) return null;
  }
  return input;
}

/**
 * 直接ping Minecraft服务器
 */
async function pingServer(host: string, port: number, type: 'java' | 'bedrock'): Promise<number> {
  const startTime = Date.now();
  if (type === 'java') {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port })
        .once('connect', () => { socket.destroy(); resolve(Date.now() - startTime); })
        .once('error', () => { socket.destroy(); resolve(-1); });
      socket.setTimeout(10000, () => { socket.destroy(); resolve(-1); });
    });
  } else {
    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      const pingData = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]);
      const timer = setTimeout(() => { client.close(); resolve(-1); }, 10000);
      client.once('message', () => {
        clearTimeout(timer); client.close(); resolve(Date.now() - startTime);
      }).once('error', () => { clearTimeout(timer); client.close(); resolve(-1); });
      client.send(pingData, port, host, err => { if (err) { clearTimeout(timer); client.close(); resolve(-1); }});
    });
  }
}

/**
 * 获取 Minecraft 服务器状态
 */
async function fetchServerStatus(server: string, forceType: 'java' | 'bedrock', config?: Config): Promise<ServerStatus> {
  const address = validateServerAddress(server);
  const serverType = forceType || 'java';
  const defaultPort = serverType === 'java' ? 25565 : 19132;
  if (!address) {
    const [host, portStr] = server.split(':');
    return {
      online: false, host: host, port: parseInt(portStr) || defaultPort, players: { online: null, max: null },
      error: '无效地址'
    };
  }
  const host = address.split(':')[0];
  const port = parseInt(address.split(':')[1]) || defaultPort;
  const apiEndpoints = config?.serverApis?.filter(api => api.type === serverType)?.map(api => api.url) || [];
  const apiResults = await Promise.allSettled(
    apiEndpoints.map(async (apiUrl) => {
      const startTime = Date.now();
      const response = await fetch(apiUrl.replace('${address}', address), { headers: { 'User-Agent': 'Mozilla/5.0' }, method: 'GET' });
      if (!response.ok) return null;
      const data = await response.json();
      const result = normalizeApiResponse(data, address, serverType);
      result.ping = Date.now() - startTime;
      return result.online && (result.version?.name_clean || result.players.online !== null) ? result : null;
    })
  );
  const successResult = apiResults
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => (result as PromiseFulfilledResult<ServerStatus>).value)[0];
  if (successResult) {
    const actualPing = await pingServer(host, port, serverType);
    if (actualPing !== -1) successResult.ping = actualPing;
    return successResult;
  }
  return {
    online: false, host, port, players: { online: null, max: null },
    error: '服务器查询失败'
  };
}

/**
 * 标准化 API 响应格式，自动猜测可能的格式
 * @param {any} data - API 响应的原始数据
 * @param {string} address - 服务器地址
 * @param {'java'|'bedrock'} serverType - 服务器类型
 * @returns {ServerStatus} 标准化后的服务器状态
 */
function normalizeApiResponse(data: any, address: string, serverType: 'java' | 'bedrock'): ServerStatus {
  const [host, portStr] = address.split(':');
  const defaultPort = serverType === 'java' ? 25565 : 19132;
  const port = parseInt(portStr) || defaultPort;
  // 检查服务器是否在线
  const isOffline = data.online === false ||  (data.status === 'error') || (data.status === 'offline') ||
                    (typeof data.status === 'string' && data.status.toLowerCase() === 'offline');
  if (isOffline) return { online: false, host: host, port: port, players: { online: null, max: null }, error: data.error || data.description };
  // 处理列表类型数据
  const processListData = (items: any, isObject = false) => {
    if (!items) return undefined;
    if (Array.isArray(items)) return items.map(item => typeof item === 'string' ? { name: item } : item);
    if (isObject && typeof items === 'object') return Object.entries(items).map(([k, v]) => ({ name: k, version: v }));
    return undefined;
  };
  // 处理MOTD
  const processMOTD = () => {
    if (!data.motd) return data.description?.text || data.description || data.server_motd;
    if (typeof data.motd === 'string') return data.motd;
    if (typeof data.motd !== 'object') return null;
    const textArray = data.motd.clean || data.motd.raw;
    if (!textArray) return null;
    return Array.isArray(textArray) ? textArray.join('\n') : textArray;
  };
  return {
    online: true, host: data.hostname || data.host || data.server || host,
    port: data.port || data.ipv6Port || port, ip_address: data.ip_address || data.ip || data.hostip,
    eula_blocked: data.eula_blocked || data.blocked, motd: processMOTD(),
    version: {
      name_clean: data.version?.name_clean || data.version || data.server?.version || data.server_version,
      name: data.version?.name || data.protocol?.name || data.version?.protocol_name
    },
    players: {
      online: data.players?.online ?? data.players?.now ?? data.players_online ?? data.online_players ?? data.playersOnline,
      max: data.players?.max ?? data.players_max ?? data.max_players ?? data.maxPlayers,
      list: Array.isArray(data.players?.list)
        ? data.players.list.map(p => typeof p === 'string' ? p : p.name || p.name_clean || p.id)
        : (Array.isArray(data.players)
           ? data.players.map(p => typeof p === 'string' ? p : p.name || p.name_clean || p.id)
           : data.players?.sample?.map(p => p.name) || data.player_list)
    },
    icon: data.icon || data.favicon || data.favocion, srv_record: data.srv_record || data.srv,
    mods: processListData(data.mods, true) ||
          data.modinfo?.modList?.map(m => ({ name: m.modid, version: m.version })) ||
          (data.modInfo ? [{ name: data.modInfo }] : null) || data.modlist,
    software: data.software || data.server?.name || data.server_software,
    plugins: processListData(data.plugins, true) || data.plugin_list,
    gamemode: data.gamemode || data.game_type || data.gametype,
    server_id: data.server_id || data.serverid || data.uuid || data.serverId,
    edition: data.edition || (serverType === 'bedrock' ? 'MCPE' : null) ||
             (data.platform === 'MINECRAFT_BEDROCK' ? 'MCPE' : null)
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
      case 'name': return status.port === 25565 || status.port === 19132 ? status.host : `${status.host}:${status.port}`;
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
      case 'playercount': return status.players.list?.length ? String(status.players.list.length) : null;
      case 'plugincount': return status.plugins?.length ? String(status.plugins.length) : null;
      case 'modcount': return status.mods?.length ? String(status.mods.length) : null;
      case 'playerlist':
        if (!status.players.list?.length) return null;
        limit = limit || status.players.list.length;
        return status.players.list.slice(0, limit)
          .map(p => p).join(', ') + (limit < status.players.list.length ? '...' : '');
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
      if (placeholders.length > 0 && placeholders.every(match => {
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
 * @returns {string|null} 服务器地址，未找到时返回null
 */
function findGroupServer(session: any, config: Config): string | null {
  const mapping = config.serverMaps.find(m => m.platform === session.platform && m.channelId === session.guildId);
  return mapping?.serverAddress || null;
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
      if (!server) {
        server = findGroupServer(session, config);
        if (!server) return '请提供服务器地址';
      }
      const status = await fetchServerStatus(server, 'java', config);
      return formatServerStatus(status, config);
    });
  mcinfo.subcommand('.be [server]', '查询 Bedrock 服务器')
    .action(async ({ session }, server) => {
      if (!server) {
        server = findGroupServer(session, config);
        if (!server) return '请提供服务器地址';
      }
      const status = await fetchServerStatus(server, 'bedrock', config);
      return formatServerStatus(status, config);
    });
}
