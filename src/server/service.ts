import { Context, Session } from 'koishi'
import { Rcon } from 'rcon-client'
import { Config } from '../index'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * WebSocket服务器配置接口
 * @interface WsServerConfig
 * @property {number} id - 服务器唯一标识
 * @property {string} name - 服务器名称
 * @property {'client' | 'server'} websocketMode - WebSocket连接模式，客户端或服务端
 * @property {string} websocketAddress - WebSocket地址，格式为"host:port"
 * @property {string} websocketToken - WebSocket认证令牌
 */
export interface WsServerConfig { id: number, name: string, websocketMode: 'client' | 'server', websocketAddress: string, websocketToken: string }

/**
 * RCON服务器配置接口
 * @interface RconServerConfig
 * @property {number} id - 服务器唯一标识
 * @property {string} rconAddress - RCON地址，格式为"host:port"
 * @property {string} rconPassword - RCON密码
 */
export interface RconServerConfig { id: number, rconAddress: string, rconPassword: string }

/**
 * Minecraft消息类型
 * @typedef {('chat'|'broadcast'|'whisper'|'title'|'actionbar')} MinecraftMessageType
 */
type MinecraftMessageType = 'chat' | 'broadcast' | 'whisper' | 'title' | 'actionbar'

/**
 * 服务器连接状态接口
 * @interface ServerConnection
 * @property {number} id - 服务器唯一标识
 * @property {string} [name] - 服务器名称
 * @property {WebSocket} [socket] - WebSocket连接
 * @property {WebSocketServer} [server] - WebSocket服务器实例
 * @property {NodeJS.Timeout} [reconnectTimer] - 重连定时器
 * @property {number} reconnectCount - 重连次数
 */
interface ServerConnection { id: number; name?: string; socket?: WebSocket; server?: WebSocketServer; reconnectTimer?: NodeJS.Timeout; reconnectCount: number; }

/**
 * 存储所有服务器连接的Map
 * @type {Map<number, ServerConnection>}
 */
const serverConnections = new Map<number, ServerConnection>();

/**
 * Minecraft事件类型常量
 * @constant {Object} EVENT_TYPES
 */
const EVENT_TYPES = {
  CHAT: ['AsyncPlayerChatEvent', 'ServerMessageEvent', 'ServerChatEvent', 'NeoServerChatEvent', 'MinecraftPlayerChatEvent', 'BaseChatEvent', 'VelocityPlayerChatEvent'],
  COMMAND: ['PlayerCommandPreprocessEvent', 'ServerCommandMessageEvent', 'CommandEvent', 'NeoCommandEvent', 'VelocityCommandExecuteEvent'],
  JOIN: ['PlayerJoinEvent', 'ServerPlayConnectionJoinEvent', 'PlayerLoggedInEvent', 'NeoPlayerLoggedInEvent', 'MinecraftPlayerJoinEvent', 'BaseJoinEvent', 'VelocityLoginEvent'],
  QUIT: ['PlayerQuitEvent', 'ServerPlayConnectionDisconnectEvent', 'PlayerLoggedOutEvent', 'NeoPlayerLoggedOutEvent', 'MinecraftPlayerQuitEvent', 'BaseQuitEvent', 'VelocityDisconnectEvent'],
  DEATH: ['PlayerDeathEvent', 'NeoPlayerDeathEvent', 'ServerLivingEntityAfterDeathEvent', 'BaseDeathEvent']
}

/**
 * 初始化WebSocket连接
 * @param {Context} ctx - Koishi上下文
 * @param {Config} config - 插件配置
 * @returns {void}
 */
export function initWebSocket(ctx: Context, config: Config) {
  if (!config.wsServers.length) return
  for (const server of config.wsServers) {
    serverConnections.set(server.id, { id: server.id, name: server.name, reconnectCount: 0 });
    server.websocketMode === 'client' ? connectAsClient(ctx, server, config) : startWebSocketServer(ctx, server, config);
  }
  function startWebSocketServer(ctx: Context, serverConfig: WsServerConfig, config: Config) {
    const address = parseWsAddress(serverConfig.websocketAddress);
    if (!address) return;
    const server = new WebSocketServer({ host: address.host, port: address.port });
    const connection = serverConnections.get(serverConfig.id);
    if (connection) connection.server = server;
    ctx.logger.info(`服务端启动 #${serverConfig.id} - ${address.host}:${address.port}`);
    server.on('connection', (ws, req) => {
      const auth = req.headers.authorization;
      const selfName = req.headers['x-self-name'];
      const clientOrigin = req.headers['x-client-origin'];
      const clientIdStr = Array.isArray(req.headers['x-server-id']) ? req.headers['x-server-id'][0] : req.headers['x-server-id'];
      if (!auth || auth !== `Bearer ${serverConfig.websocketToken}` ||
          !selfName || selfName !== serverConfig.name ||
          clientIdStr !== String(serverConfig.id)) {
        ws.close(1008, 'Authorization failed');
        return;
      }
      ctx.logger.info(`已连接 #${serverConfig.id} - ${clientOrigin || '未知'}`);
      setupWebSocket(ws, ctx, serverConfig, config, false);
    });
    server.on('error', err => ctx.logger.error(`错误 #${serverConfig.id} - ${err.message}`));
  }
}

/**
 * 解析WebSocket地址
 * @param {string} address - WebSocket地址，格式为"host:port"
 * @returns {{ host: string, port: number } | null} 解析后的地址对象或null
 */
function parseWsAddress(address: string) {
  if (!address?.trim()) return null;
  const [host, portStr] = address.split(':');
  const port = parseInt(portStr);
  return (!host?.trim() || !portStr || isNaN(port)) ? null : { host, port };
}

/**
 * 发送群组通知消息
 * @param {Context} ctx - Koishi上下文
 * @param {WsServerConfig} serverConfig - WebSocket服务器配置
 * @param {string} message - 通知消息内容
 * @param {Config} config - 插件配置
 * @returns {void}
 */
function sendGroupNotification(ctx: Context, serverConfig: WsServerConfig, message: string, config: Config) {
  config.serverMaps.filter(m => m.serverId === serverConfig.id).forEach(mapping => {
    const bot = ctx.bots[mapping.platform];
    if (bot) bot.sendMessage(mapping.channelId, message);
  });
}

/**
 * 设置WebSocket连接事件处理
 * @param {WebSocket} ws - WebSocket连接实例
 * @param {Context} ctx - Koishi上下文
 * @param {WsServerConfig} serverConfig - WebSocket服务器配置
 * @param {Config} config - 插件配置
 * @param {boolean} isClient - 是否为客户端模式
 * @returns {void}
 */
function setupWebSocket(ws: WebSocket, ctx: Context, serverConfig: WsServerConfig, config: Config, isClient = true) {
  const connection = serverConnections.get(serverConfig.id);
  if (connection) connection.socket = ws;
  sendGroupNotification(ctx, serverConfig, `已连接服务器 #${serverConfig.id}`, config);
  ws.send(JSON.stringify({ api: "send_msg", data: { message: { type: "text", data: { text: `[mc-tools] 连接成功` } } } }));
  ws.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.event_name) handleMinecraftEvent(ctx, message, serverConfig, config);
    } catch (err) {
      ctx.logger.error(`服务器 #${serverConfig.id} 消息解析失败:`, err);
    }
  });
  ws.on('error', err => ctx.logger.error(`${isClient ? '客户端' : '连接'}错误 #${serverConfig.id} - ${err.message}`));
  ws.on('close', () => {
    ctx.logger.warn(`${isClient ? '服务端' : '客户端'}断开 #${serverConfig.id}`);
    const conn = serverConnections.get(serverConfig.id);
    if (conn) conn.socket = undefined;
    isClient ? handleReconnection(ctx, serverConfig, config) :
      sendGroupNotification(ctx, serverConfig, `服务器 #${serverConfig.id} 已断开`, config);
  });
}

/**
 * 处理WebSocket重连
 * @param {Context} ctx - Koishi上下文
 * @param {WsServerConfig} serverConfig - WebSocket服务器配置
 * @param {Config} config - 插件配置
 * @returns {void}
 */
function handleReconnection(ctx: Context, serverConfig: WsServerConfig, config: Config) {
  const connection = serverConnections.get(serverConfig.id);
  if (!connection) return;
  if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
  if (connection.reconnectCount < 6) {
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectCount++;
      connectAsClient(ctx, serverConfig, config);
    }, 10000);
  } else {
    sendGroupNotification(ctx, serverConfig, `服务器 ${serverConfig.name} 已断开连接`, config);
  }
}

/**
 * 作为客户端连接WebSocket服务器
 * @param {Context} ctx - Koishi上下文
 * @param {WsServerConfig} serverConfig - WebSocket服务器配置
 * @param {Config} config - 插件配置
 * @returns {void}
 */
function connectAsClient(ctx: Context, serverConfig: WsServerConfig, config: Config) {
  const address = parseWsAddress(serverConfig.websocketAddress);
  if (!address) return;
  const socket = new WebSocket(`ws://${address.host}:${address.port}/minecraft/ws`, {
    headers: {
      'Authorization': `Bearer ${serverConfig.websocketToken}`,
      'x-self-name': serverConfig.name,
      'x-client-origin': 'koishi',
      'x-server-id': serverConfig.id
    }
  });
  socket.on('open', () => {
    ctx.logger.info(`客户端已连接 #${serverConfig.id} - ${address.host}:${address.port}`);
    const connection = serverConnections.get(serverConfig.id);
    if (connection) connection.reconnectCount = 0;
    setupWebSocket(socket, ctx, serverConfig, config, true);
  });
  socket.on('error', err => ctx.logger.error(`客户端错误 #${serverConfig.id} - ${err.message}`));
  socket.on('close', () => handleReconnection(ctx, serverConfig, config));
}

/**
 * 处理Minecraft事件
 * @param {Context} ctx - Koishi上下文
 * @param {any} message - 事件消息对象
 * @param {WsServerConfig} serverConfig - WebSocket服务器配置
 * @param {Config} config - 插件配置
 * @returns {void}
 */
function handleMinecraftEvent(ctx: Context, message: any, serverConfig: WsServerConfig, config: Config) {
  const serverName = message.server_name || serverConfig.name;
  const eventName = message.event_name || '';
  const player = message.player || {};
  const locationInfo = player.block_x !== undefined ? ` [位置: ${player.block_x}, ${player.block_y}, ${player.block_z}]` : '';
  const gameModeInfo = player.game_mode ?
    ` [模式: ${player.game_mode}]` :
    (player?.is_spectator !== undefined ?
      ` [模式: ${player.is_spectator ? '旁观者' : player.is_creative ? '创造' : '生存'}]` : '');
  let content = '';
  if (EVENT_TYPES.CHAT.includes(eventName)) {
    content = `[${serverName}] ${message.player?.nickname}: ${message.message || ''}`;
  } else if (EVENT_TYPES.COMMAND.includes(eventName)) {
    content = `[${serverName}] ${message.player?.nickname} 在 ${locationInfo} 执行了命令: ${message.message?.trim() || ''}`;
  } else if (EVENT_TYPES.JOIN.includes(eventName)) {
    content = `[${serverName}] ${message.player?.nickname} 加入了游戏`;
    if (message.player) {
      if (message.player.display_name && message.player.display_name !== message.player.nickname)
        content += ` (显示名: ${message.player.display_name})`;
      content += gameModeInfo + locationInfo;
      const ip = message.player.ip || message.player.ipAddress || message.player.address;
      if (ip) content += ` [IP: ${ip}]`;
    }
  } else if (EVENT_TYPES.QUIT.includes(eventName)) {
    content = `[${serverName}] ${message.player?.nickname} 离开了游戏${locationInfo}`;
  } else if (EVENT_TYPES.DEATH.includes(eventName)) {
    content = message.message ?
      `[${serverName}] ${message.message}` :
      `[${serverName}] ${message.player?.nickname} 在 ${locationInfo} 死亡了`;
  } else if (message.message) {
    content = `[${serverName}] ${message.message}`;
  }
  if (content) {
    config.serverMaps.filter(m => m.serverId === serverConfig.id).forEach(mapping => {
      const bot = ctx.bots[mapping.platform];
      if (bot) bot.sendMessage(mapping.channelId, content);
    });
  }
}

/**
 * 清理所有WebSocket连接
 * @returns {void}
 */
export function cleanupWebSocket() {
  for (const connection of serverConnections.values()) {
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    if (connection.socket) connection.socket.close();
    if (connection.server) connection.server.close();
  }
  serverConnections.clear();
}

/**
 * 执行RCON命令
 * @param {string} command - 要执行的命令
 * @param {RconServerConfig} serverConfig - RCON服务器配置
 * @param {Session} session - Koishi会话
 * @returns {Promise<void>}
 */
export async function executeRconCommand(command: string, serverConfig: RconServerConfig, session: Session): Promise<void> {
  if (!command) {
    session.send('请输入要执行的命令');
    return;
  }
  const [serverHost, portStr] = (serverConfig.rconAddress || '').split(':');
  const port = parseInt(portStr || '');
  if (!serverConfig.rconPassword || !serverHost || !portStr || isNaN(port)) {
    session.send(`服务器 #${serverConfig.id} RCON 配置错误`);
    return;
  }
  try {
    const rcon = await Rcon.connect({host: serverHost, port, password: serverConfig.rconPassword});
    const result = await rcon.send(command);
    await rcon.end();
    await session.send(result ? `已执行命令 [#${serverConfig.id}]\n${result}` : `已执行命令 [#${serverConfig.id}]`);
  } catch (error) {
    await session.send(`命令执行失败 [#${serverConfig.id}] - ${error.message}`);
  }
}

/**
 * 发送Minecraft消息
 * @param {MinecraftMessageType} messageType - 消息类型
 * @param {any} message - 消息内容
 * @param {object} options - 消息选项
 * @param {string} [options.player] - 目标玩家，用于私聊消息
 * @param {any} [options.subtitle] - 副标题，用于标题消息
 * @param {number} [options.fadein] - 淡入时间，用于标题消息
 * @param {number} [options.stay] - 停留时间，用于标题消息
 * @param {number} [options.fadeout] - 淡出时间，用于标题消息
 * @param {Session} [options.session] - Koishi会话
 * @param {number} options.serverId - 目标服务器ID
 * @param {boolean} [options.feedback=true] - 是否发送反馈消息
 * @returns {Promise<boolean>} 是否发送成功
 */
export async function sendMinecraftMessage(messageType: MinecraftMessageType, message: any,
  options: {
    player?: string, subtitle?: any, fadein?: number,
    stay?: number, fadeout?: number, session?: Session,
    serverId: number, feedback?: boolean
  }
): Promise<boolean> {
  const { player, subtitle, fadein, stay, fadeout, session, serverId, feedback = true } = options;
  if (!session) return false;
  const formatContent = (content: any): string | any[] =>
    typeof content === 'string' ? content : (Array.isArray(content) ? content : [content]);
  const formattedMessage = formatContent(message);
  const configs = {
    chat: { api: 'send_msg', successMsg: '已发送消息', failMsg: '消息发送失败' },
    broadcast: { api: 'broadcast', successMsg: '已发送广播', failMsg: '广播发送失败' },
    whisper: { api: 'send_private_msg', successMsg: '已发送私聊', failMsg: '私聊发送失败' },
    title: { api: 'send_title', successMsg: '已发送标题', failMsg: '标题发送失败' },
    actionbar: { api: 'send_actionbar', successMsg: '已发送动作栏', failMsg: '动作栏发送失败' }
  };
  const config = configs[messageType];
  let messageData: any = { message: formattedMessage };
  if (messageType === 'whisper' && player) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player);
    messageData[isUuid ? 'uuid' : 'nickname'] = player;
  } else if (messageType === 'title') {
    messageData = {
      title: formattedMessage,
      ...(subtitle && { subtitle: formatContent(subtitle) }),
      ...(fadein !== undefined && { fadein }),
      ...(stay !== undefined && { stay }),
      ...(fadeout !== undefined && { fadeout })
    };
  }
  const socket = serverConnections.get(serverId)?.socket;
  if (!socket) {
    if (feedback) session.send(`服务器 #${serverId} 未连接`);
    return false;
  }
  try {
    socket.send(JSON.stringify({ api: config.api, data: messageData }));
    if (feedback) session.send(`${config.successMsg} [#${serverId}]`);
    return true;
  } catch (error) {
    if (feedback) session.send(`${config.failMsg} [#${serverId}]`);
    return false;
  }
}

/**
 * 格式化Minecraft文本
 * @param {string} text - 要格式化的文本
 * @param {any} [options={}] - 格式化选项
 * @param {boolean} [isSubtitle=false] - 是否是副标题
 * @returns {object} 格式化后的文本对象及时间参数
 */
export function formatMinecraftText(text: string, options: any = {}, isSubtitle = false) {
  const prefix = isSubtitle ? 'sub' : '';
  const formatOption = options[`${prefix}format`];
  const parseFormatString = (format: string): any => {
    if (!format) return {};
    const styles: any = {};
    const colorCodes: Record<string, string> = {
      '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua',
      '4': 'dark_red', '5': 'dark_purple', '6': 'gold', '7': 'gray',
      '8': 'dark_gray', '9': 'blue', 'a': 'green', 'b': 'aqua',
      'c': 'red', 'd': 'light_purple', 'e': 'yellow', 'f': 'white'
    };
    format = format.replace(/§([0-9a-fk-or])/gi, (_, code) => {
      code = code.toLowerCase();
      if (code in colorCodes) styles.color = colorCodes[code];
      else if (code === 'k') styles.obfuscated = true;
      else if (code === 'l') styles.bold = true;
      else if (code === 'm') styles.strikethrough = true;
      else if (code === 'n') styles.underlined = true;
      else if (code === 'o') styles.italic = true;
      else if (code === 'r') Object.keys(styles).forEach(key => delete styles[key]);
      return '';
    });
    format.split(/\s+/).forEach(part => {
      if (!part) return;
      if (part.startsWith('color:') || part.startsWith('c:')) styles.color = part.split(':')[1];
      else if (part.startsWith('font:') || part.startsWith('f:')) styles.font = part.split(':')[1];
      else if (part.startsWith('click:')) {
        const [action, ...valueParts] = part.substring(6).split('=');
        const value = valueParts.join('=');
        const actions: Record<string, string> = {
          url: 'open_url', run: 'run_command', suggest: 'suggest_command', copy: 'copy_to_clipboard'
        };
        if (action in actions) styles.clickEvent = { action: actions[action], value };
      }
      else if (part.startsWith('hover:')) {
        const [action, ...valueParts] = part.substring(6).split('=');
        const value = valueParts.join('=');
        if (action === 'text') styles.hoverEvent = { action: 'show_text', contents: value };
        else if (action === 'item') styles.hoverEvent = { action: 'show_item', item: { id: value } };
        else if (action === 'entity') styles.hoverEvent = { action: 'show_entity', entity: { id: value } };
      }
      else if (part.startsWith('insert:')) styles.insertion = part.substring(7);
      else if (part.startsWith('time:')) {
        const times = part.substring(5).split(',').map(Number);
        if (times.length >= 1 && !isNaN(times[0])) styles.fadein = times[0];
        if (times.length >= 2 && !isNaN(times[1])) styles.stay = times[1];
        if (times.length >= 3 && !isNaN(times[2])) styles.fadeout = times[2];
      }
      else if (['bold', 'b'].includes(part)) styles.bold = true;
      else if (['italic', 'i'].includes(part)) styles.italic = true;
      else if (['underlined', 'u'].includes(part)) styles.underlined = true;
      else if (['strikethrough', 's'].includes(part)) styles.strikethrough = true;
      else if (['obfuscated', 'o'].includes(part)) styles.obfuscated = true;
    });
    return styles;
  };
  const styles = formatOption ? parseFormatString(formatOption) : {};
  const timeParams = {fadein: styles.fadein, stay: styles.stay, fadeout: styles.fadeout};
  delete styles.fadein; delete styles.stay; delete styles.fadeout;
  if (Object.keys(styles).length === 0) return { text, timeParams };
  const data: any = { text };
  if (styles.color?.trim()) data.color = styles.color;
  if (styles.font) data.font = styles.font;
  ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'].forEach(
    style => { if (style in styles) data[style] = styles[style]; }
  );
  if (styles.insertion) data.insertion = styles.insertion;
  if (styles.clickEvent) data.click_event = styles.clickEvent;
  if (styles.hoverEvent) data.hover_event = styles.hoverEvent;
  return { text: { type: 'text', data }, timeParams };
}

/**
 * 查找服务器配置
 * @param {Config} config - 插件配置
 * @param {number} serverId - 服务器ID
 * @returns {object} 服务器配置信息对象
 * @returns {boolean} .found - 是否找到服务器配置
 * @returns {number} .id - 服务器ID
 * @returns {string} .displayName - 服务器显示名称
 * @returns {RconServerConfig|null} .rconConfig - RCON服务器配置或null
 * @returns {WsServerConfig|null} .wsConfig - WebSocket服务器配置或null
 */
export function findServer(config: Config, serverId: number) {
  const rconServer = config.rconServers.find(s => s.id === serverId);
  const wsServer = config.wsServers.find(s => s.id === serverId);
  return {
    found: !!(rconServer || wsServer),
    id: serverId,
    displayName: wsServer?.name || `服务器 #${serverId}`,
    rconConfig: rconServer || null,
    wsConfig: wsServer || null
  };
}