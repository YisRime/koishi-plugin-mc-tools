import { Context, h } from 'koishi'
import axios from 'axios'

export type LangCode = keyof typeof MINECRAFT_LANGUAGES

export interface MinecraftVersionInfo {
  id: string
  type: string
  releaseTime: string
}
export interface SearchResult {
  title: string
  url: string
  desc?: string
  source: 'wiki' | 'mcmod'
}
export interface SearchModResult {
  source: 'modrinth' | 'curseforge'
  id: string | number
  type: string
  title: string
  description: string
  categories: string[]
}
export interface ModrinthProject {
  slug: string
  title: string
  description: string
  categories: string[]
  client_side: string
  server_side: string
  project_type: string
  body: string
  game_versions?: string[]
  loaders?: string[]
}
export interface CurseForgeProject {
  id: number
  name: string
  summary: string
  description: string
  categories: (string | { name: string })[]
  classId: number
  latestFiles: {
    displayName: string
    gameVersions: string[]
  }[]
  links: {
    websiteUrl: string
  }
}

interface ParsedServer {
  host: string
  port: number
}
interface BedrockServerInfo {
  edition: string
  motd: string
  protocol: string
  version: string
  online: number
  max: number
}
interface TexturesData {
  textures: {
    SKIN?: {
      url: string
      metadata?: {
        model: 'slim' | 'classic'
      }
    }
    CAPE?: {
      url: string
    }
  }
}
interface PlayerProfile {
  name: string
  uuid: string
  uuidDashed: string
  skin?: {
    url: string
    model: 'slim' | 'classic'
  }
  cape?: {
    url: string
  }
}

export const CLEANUP_SELECTORS = [
  // Wiki 相关
  '.mw-editsection', '#mw-navigation', '#footer', '.noprint', '#toc',
  '.navbox', '#siteNotice', '#contentSub', '.mw-indicators',
  '.sister-wiki', '.external', 'script', 'meta', '#mw-head',
  '#mw-head-base', '#mw-page-base', '#catlinks', '.printfooter',
  '.mw-jump-link', '.vector-toc', '.vector-menu',
  '.mw-cite-backlink', '.reference', '.treeview',
  '.file-display-header',
  // MCMOD 相关
  'header', 'footer', '.header-container', '.common-background',
  '.common-nav', '.common-menu-page', '.common-comment-block',
  '.comment-ad', '.ad-leftside', '.slidetips', '.item-table-tips',
  '.common-icon-text-frame', '.common-ad-frame', '.ad-class-page',
  '.class-rating-submit', '.common-icon-text.edit-history',
  // MCMOD 论坛相关
  '.ad', '.under', '#scrolltop', '.po', '#f_pst', '.psth', '.sign', '.sd',
  '#append_parent', '.wrap-posts.total', '.rate', '.ratl','.cm', '.modact',
]

export const TypeMap = {
  errorPatterns: {
    'ECONNREFUSED': '服务器拒绝连接',
    'ETIMEDOUT': '连接超时',
    'ENOTFOUND': '无法解析服务器地址',
    'ECONNRESET': '服务器断开了连接',
    'EHOSTUNREACH': '无法访问目标服务器',
    'ENETUNREACH': '网络不可达',
    'EPROTO': '协议错误',
    'ECONNABORTED': '连接中断',
    'EPIPE': '连接异常断开',
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
  },
  modrinthTypes: {
    'mod': '模组',
    'resourcepack': '资源包',
    'datapack': '数据包',
    'shader': '光影',
    'modpack': '整合包',
    'plugin': '插件'
  },
  facets: {
    'mod': ['project_type:mod'],
    'resourcepack': ['project_type:resourcepack'],
    'datapack': ['project_type:datapack'],
    'shader': ['project_type:shader'],
    'modpack': ['project_type:modpack'],
    'plugin': ['project_type:plugin']
  } as const,
  curseforgeTypes: {
    6: 'mod',
    12: 'resourcepack',
    17: 'modpack',
    4471: 'shader',
    4546: 'datapack',
    4944: 'world',
    5141: 'addon',
    5232: 'plugin',
  },
  curseforgeTypeNames: {
    'mod': '模组',
    'resourcepack': '资源包',
    'modpack': '整合包',
    'shader': '光影',
    'datapack': '数据包',
    'world': '地图',
    'addon': '附加包',
    'plugin': '插件'
  },
  isValidType: (source: 'modrinth' | 'curseforge', type?: string): boolean => {
    if (!type) return true
    const types = source === 'modrinth' ? Object.keys(TypeMap.modrinthTypes) : Object.values(TypeMap.curseforgeTypes)
    return types.includes(type as any)
  }
}

export const MINECRAFT_LANGUAGES = {
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

export interface CommonConfig {
  Timeout: number
  totalLength: number
  descLength: number
}

export interface MinecraftToolsConfig {
  wiki: CommonConfig
  search: {
    Language: LangCode
    sectionLength: number
    linkCount: number
    cfApi: string
  }
  info: {
    default: string
    showPlayers: boolean
    showIcon: boolean
  }
  ver: {
    enabled: boolean
    groups: string[]
    interval: number
    release: boolean
    snapshot: boolean
  }
}

/**
 * 获取 Minecraft 版本信息
 * @param {number} timeout - 请求超时时间(毫秒)
 * @returns {Promise<{latest: MinecraftVersionInfo, release: MinecraftVersionInfo, versions: MinecraftVersionInfo[]}>}
 * @throws {Error} 当版本数据无效或请求失败时抛出错误
 */
export async function fetchVersions(timeout = 10000) {
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

/**
 * 获取格式化的 Minecraft 版本信息
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
export async function getVersionInfo() {
  try {
    const { latest, release } = await fetchVersions()
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

/**
 * 向目标群组发送版本更新通知
 * @param {Context} ctx - Koishi 上下文
 * @param {string[]} targetGroups - 目标群组ID列表
 * @param {string} updateMessage - 更新消息内容
 * @private
 */
async function notifyVersionUpdate(ctx: any, targetGroups: string[], updateMessage: string) {
  for (const gid of targetGroups) {
    for (const bot of ctx.bots) {
      try {
        await bot.sendMessage(gid, updateMessage)
      } catch (e) {
        ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
      }
    }
  }
}

/**
 * 检查 Minecraft 版本更新并发送通知
 * @param {{snapshot: string, release: string}} versions - 当前版本信息
 * @param {any} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export async function checkUpdate(versions: { snapshot: string, release: string }, ctx: any, config: MinecraftToolsConfig) {
  try {
    const { latest, release } = await fetchVersions()
    const updates = [
      { type: 'snapshot', version: latest, enabled: config.ver.snapshot },
      { type: 'release', version: release, enabled: config.ver.release }
    ]

    for (const { type, version, enabled } of updates) {
      if (versions[type] && version.id !== versions[type] && enabled) {
        const msg = `发现MC更新：${version.id} (${type})\n发布时间：${new Date(version.releaseTime).toLocaleString('zh-CN')}`
        await notifyVersionUpdate(ctx, config.ver.groups, msg)
      }
      versions[type] = version.id
    }
  } catch (error) {
    ctx.logger('mc-tools').warn('版本检查失败：', error)
  }
}

/**
 * 解析 Minecraft 服务器地址和端口
 * @param {string | undefined} serverAddress - 服务器地址字符串，格式为 "host:port" 或 "host"
 * @param {MinecraftToolsConfig['info']} defaultConfig - 默认服务器配置
 * @returns {ParsedServer} 解析后的服务器信息对象
 * @throws {Error} 当地址格式无效或端口号不合法时抛出错误
 * @private
 */
function parseServer(serverAddress: string | undefined, defaultConfig: MinecraftToolsConfig['info']): ParsedServer {
  const address = serverAddress || defaultConfig.default
  const [host, portStr] = address.split(':')
  if (!host) throw new Error('请输入有效的服务器地址')

  let port = 25565
  if (portStr) {
    const parsedPort = parseInt(portStr)
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('端口号必须在1-65535之间')
    }
    port = parsedPort
  }

  return { host, port }
}

/**
 * 格式化错误消息
 * @param {any} error - 错误对象
 * @returns {string} 格式化后的错误消息
 */
export function formatErrorMessage(error: any): string {
  const errorMessage = error?.message || String(error)

  if (error?.code && TypeMap.errorPatterns[error.code]) {
    return TypeMap.errorPatterns[error.code]
  }

  for (const [pattern, message] of Object.entries(TypeMap.errorPatterns)) {
    if (new RegExp(pattern, 'i').test(errorMessage)) {
      return message
    }
  }

  return `无法连接到服务器：${errorMessage}`
}

/**
 * 创建 Varint 编码的 Buffer
 * @param {number} value - 要编码的数值
 * @returns {Buffer} 编码后的 Buffer
 * @private
 */
function writeVarInt(value: number): Buffer {
  const bytes = []
  do {
    let temp = value & 0b01111111
    value >>>= 7
    if (value !== 0) {
      temp |= 0b10000000
    }
    bytes.push(temp)
  } while (value !== 0)
  return Buffer.from(bytes)
}

/**
 * 查询Java版服务器状态
 * @param {string} host - 服务器主机地址
 * @param {number} port - 服务器端口
 * @returns {Promise<Object>} 服务器状态信息
 * @private
 */
async function queryJavaServer(host: string, port: number): Promise<{
  motd: string
  version: string
  online: number
  max: number
  playerList?: string[]
  favicon?: string
  ping: number
}> {
  const startTime = Date.now()

  return new Promise((resolve, reject) => {
    const net = require('net')
    const socket = new net.Socket()
    let buffer = Buffer.alloc(0)

    socket.setTimeout(5000)

    socket.on('error', (err) => {
      socket.destroy()
      reject(err)
    })

    socket.on('timeout', () => {
      socket.destroy()
      const err = new Error('请求超时')
      err['code'] = 'ETIMEDOUT'
      reject(err)
    })

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      try {
        const response = JSON.parse(buffer.toString('utf8').split('\x00\x00')[1])
        socket.destroy()

        const parseMOTD = (motd: any): string => {
          if (!motd) return ''
          if (typeof motd === 'string') return motd.replace(/§[0-9a-fk-or]/gi, '')
          if (typeof motd !== 'object') return String(motd)

          let result = ''
          if ('text' in motd) result += motd.text
          if ('extra' in motd && Array.isArray(motd.extra)) {
            result += motd.extra.map(parseMOTD).join('')
          }
          if (Array.isArray(motd)) {
            result += motd.map(parseMOTD).join('')
          }
          return result.replace(/§[0-9a-fk-or]/gi, '')
        }

        resolve({
          motd: parseMOTD(response.description),
          version: response.version?.name || '未知版本',
          online: response.players?.online ?? 0,
          max: response.players?.max ?? 0,
          playerList: response.players?.sample?.map(p => p.name),
          favicon: response.favicon,
          ping: Date.now() - startTime
        })
      } catch (err) {
        // 如果解析失败，继续等待更多数据
      }
    })

    socket.connect(port, host, () => {
      // 发送握手包和状态请求包
      const hostBuffer = Buffer.from(host, 'utf8')
      const handshakePacket = Buffer.concat([
        writeVarInt(0), // Packet ID
        writeVarInt(47), // Protocol Version
        writeVarInt(hostBuffer.length),
        hostBuffer,
        Buffer.from([port >> 8, port & 255]), // Port
        writeVarInt(1), // Next State (1 for Status)
      ])

      const handshake = Buffer.concat([
        writeVarInt(handshakePacket.length),
        handshakePacket
      ])

      const statusRequest = Buffer.from([0x01, 0x00])

      socket.write(handshake)
      socket.write(statusRequest)
    })
  })
}

/**
 * 查询基岩版服务器状态
 * @param {string} host - 服务器主机地址
 * @param {number} port - 服务器端口
 * @returns {Promise<Object>} 服务器状态信息
 * @private
 */
async function queryBedrockServer(host: string, port: number): Promise<{
  motd: string
  version: string
  online: number
  max: number
  ping: number
}> {
  const startTime = Date.now()
  const result = await new Promise<BedrockServerInfo>((resolve, reject) => {
    const dgram = require('dgram')
    const client = dgram.createSocket('udp4')

    const timeout = setTimeout(() => {
      client.close()
      const error = new Error('请求超时')
      error['code'] = 'ETIMEDOUT'
      reject(error)
    }, 5000)

    const query = Buffer.from([
      0x01,
      0x00,
      ...Buffer.from([Math.floor(Date.now() / 1000)].map(n => [
        (n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF
      ]).flat()),
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ])

    client.on('message', (msg) => {
      clearTimeout(timeout)
      client.close()

      try {
        const data = msg.toString('utf8', 35).split(';')
        if (data.length < 6) {
          const error = new Error('无效的服务器响应')
          error['code'] = 'invalid server response'
          throw error
        }

        resolve({
          edition: data[0],
          motd: data[1],
          protocol: data[2],
          version: data[3],
          online: parseInt(data[4]),
          max: parseInt(data[5])
        })
      } catch (error) {
        reject(error)
      }
    })

    client.on('error', (err: any) => {
      clearTimeout(timeout)
      client.close()
      reject(err)
    })

    client.send(query, port, host)
  })

  return {
    motd: result.motd,
    version: `${result.version}`,
    online: result.online,
    max: result.max,
    ping: Date.now() - startTime
  }
}

/**
 * 检查服务器状态
 */
export async function checkServerStatus(server: string | undefined, config: MinecraftToolsConfig) {
  const { host, port } = parseServer(server, config.info)

  const isDefaultJava = port === 25565
  const isDefaultBedrock = port === 19132

  try {
    let result
    if (isDefaultBedrock) {
      result = await queryBedrockServer(host, port)
    } else if (isDefaultJava) {
      result = await queryJavaServer(host, port)
    } else {
      const results = await Promise.race([
        queryJavaServer(host, port).catch(e => ({ error: e, type: 'java' })),
        queryBedrockServer(host, port).catch(e => ({ error: e, type: 'bedrock' }))
      ])

      if ('error' in results) {
        throw results.error
      }
      result = results
    }

    const lines: string[] = []

    if (config.info.showIcon && 'favicon' in result && result.favicon?.startsWith('data:image/png;base64,')) {
      lines.push(h.image(result.favicon).toString())
    }

    if (result.motd) lines.push(result.motd)

    const statusParts = [
      result.version,
      `${result.online}/${result.max}`,
      `${result.ping}ms`
    ]
    lines.push(statusParts.join(' | '))

    if (config.info.showPlayers && result.playerList?.length > 0) {
      const playerInfo = ['当前在线：' + result.playerList.join(', ')]
      if (result.playerList.length < result.online) {
        playerInfo.push(`（仅显示 ${result.playerList.length}/${result.online} 名玩家）`)
      }
      lines.push(playerInfo.join(''))
    }

    const data = lines.join('\n')
    return server ? data : `${host}:${port}\n${data}`

  } catch (error) {
    throw new Error(formatErrorMessage(error))
  }
}

/**
 * 获取完整的玩家信息
 * @param {string} username - 玩家用户名
 * @returns {Promise<PlayerProfile>} 完整的玩家信息
 * @throws {Error} 当无法获取玩家信息时抛出错误
 */
export async function getPlayerProfile(username: string): Promise<PlayerProfile> {
  try {
    // 1. 获取基础信息
    const { data: basicData } = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!basicData) throw new Error('玩家不存在');

    // 2. 获取档案数据
    const { data: profileData } = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${basicData.id}`);

    // 3. 解析材质信息
    let texturesData: TexturesData | null = null;
    if (profileData.properties?.[0]?.value) {
      texturesData = JSON.parse(Buffer.from(profileData.properties[0].value, 'base64').toString());
    }

    // 4. 格式化UUID
    const uuidDashed = [
      basicData.id.slice(0, 8),
      basicData.id.slice(8, 12),
      basicData.id.slice(12, 16),
      basicData.id.slice(16, 20),
      basicData.id.slice(20)
    ].join('-');

    // 5. 构建玩家档案
    const profile: PlayerProfile = {
      name: basicData.name,
      uuid: basicData.id,
      uuidDashed
    };

    // 6. 添加皮肤和披风信息
    if (texturesData?.textures) {
      if (texturesData.textures.SKIN) {
        profile.skin = {
          url: texturesData.textures.SKIN.url,
          model: texturesData.textures.SKIN.metadata?.model || 'classic'
        };
      }

      if (texturesData.textures.CAPE) {
        profile.cape = {
          url: texturesData.textures.CAPE.url
        };
      }
    }

    return profile;

  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error('找不到该玩家');
    }
    if (error.response?.status === 400) {
      throw new Error('无效的UUID格式');
    }
    if (error.response?.status === 204) {
      throw new Error('该UUID未关联任何玩家');
    }
    if (error.response?.status === 429) {
      throw new Error('请求过于频繁');
    }
    throw new Error(`无法获取玩家信息: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * 渲染玩家皮肤和披风，生成两个不同角度的视图
 * @param {Context} ctx - Koishi 上下文对象，用于获取 Puppeteer 实例
 * @param {string} skinUrl - 玩家皮肤的 URL 地址
 * @param {string} [capeUrl] - 玩家披风的 URL 地址（可选）
 * @returns {Promise<string>} 返回渲染后的图片 Base64 编码字符串
 */
export async function renderPlayerSkin(ctx: Context, skinUrl: string, capeUrl?: string): Promise<string> {
  const page = await ctx.puppeteer.page()
  await page.setViewport({ width: 400, height: 400 })

  const html = `
    <html>
      <head>
        <script src="https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js"></script>
        <style>
          body { margin: 0; background: transparent; display: flex; justify-content: center; align-items: center; }
          .container { display: flex; width: 400px; height: 400px; }
          .view { width: 200px; height: 400px; }
        </style>
      </head>
      <body>
        <div class="container">
          <canvas id="view1" class="view"></canvas>
          <canvas id="view2" class="view"></canvas>
        </div>
        <script>
          const createView = (id, rotationAngle) => {
            const viewer = new skinview3d.SkinViewer({
              canvas: document.getElementById(id),
              width: 200,
              height: 400,
              preserveDrawingBuffer: true,
              fov: 30,
              zoom: 0.95
            });

            viewer.renderer.setClearColor(0x000000, 0);  // 设置透明背景
            viewer.playerObject.rotation.y = rotationAngle;
            viewer.animation = null;  // 完全禁用动画

            return viewer;
          };

          (async () => {
            // 创建左右两个视图，分别旋转 -36° 和 144° (-36° + 180°)
            const view1 = createView('view1', -Math.PI / 5);
            const view2 = createView('view2', Math.PI * 4 / 5);
            // 为每个视图加载皮肤和披风（如果有）
            for (const view of [view1, view2]) {
              await view.loadSkin("${skinUrl}");
              ${capeUrl ? `await view.loadCape("${capeUrl}");` : ''}
              view.render();
            }
          })();
        </script>
      </body>
    </html>
  `

  await page.setContent(html)
  await page.waitForFunction(() => {
    const v1 = document.getElementById('view1')
    const v2 = document.getElementById('view2')
    return v1 && v2 &&
           (v1 as HTMLCanvasElement).toDataURL() !== 'data:,' &&
           (v2 as HTMLCanvasElement).toDataURL() !== 'data:,'
  }, { timeout: 5000 })

  await new Promise(resolve => setTimeout(resolve, 100))

  // 截取渲染结果
  const element = await page.$('.container')
  const screenshot = await element.screenshot({
    encoding: 'base64',
    omitBackground: true
  }) as string

  await page.close()
  return screenshot
}
