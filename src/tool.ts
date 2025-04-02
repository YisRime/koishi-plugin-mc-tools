import { h, Context, Logger } from 'koishi'
import axios from 'axios'
import { MTConfig } from './index'

const logger = new Logger('mcver')

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

// 皮肤相关接口定义
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
    if (host.toLowerCase() === 'localhost' || host === '0.0.0.0') {
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
          lowerIP.startsWith('ff') || lowerIP === '::') {
        throw new Error('不允许连接到私有网络地址')
      }
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
 * @param {MTConfig} [config] - 配置选项
 * @returns {Promise<ServerStatus>} 服务器状态信息
 */
export async function checkServerStatus(
  server?: string,
  forceType?: 'java' | 'bedrock',
  config?: MTConfig
): Promise<ServerStatus> {
  try {
    const parsed = parseServerAddress(server, config?.tool.default)
    const type = forceType || parsed.type

    const apis = type === 'java' ? config?.tool.javaApis : config?.tool.bedrockApis
    if (!apis?.length) {
      throw new Error(`缺少 ${type} 版本查询 API 配置`)
    }

    const errors: string[] = []
    for (const apiUrl of apis) {
      const actualUrl = apiUrl.replace('${address}', parsed.address)
      try {
        const response = await axios.get(actualUrl, {
          headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'},
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
 * @param {MTConfig['info']} config - 信息显示配置
 * @returns {string} 格式化后的状态信息
 */
export function formatServerStatus(status: ServerStatus, config: MTConfig['tool']) {
  if (!status.online) {
    return status.error || '服务器离线 - 连接失败'
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

// 从 ver.ts 移动来的代码
const API_SOURCES = {
  MOJANG: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  BMCLAPI: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json',
}

/**
 * 获取 Minecraft 版本信息
 * @param {number} timeout - 请求超时时间(毫秒)
 * @returns {Promise<{latest: any, release: any, versions: any[]}>}
 * @throws {Error} 当所有 API 源都请求失败时抛出错误
 */
async function fetchVersions(timeout = 10000) {
  const apiSources = Object.values(API_SOURCES)
  let lastError = null

  for (const apiUrl of apiSources) {
    try {
      const { data } = await axios.get(apiUrl, { timeout })

      const latest = data.versions[0]
      const release = data.versions.find(v => v.type === 'release')

      if (!latest || !release) {
        throw new Error('版本数据解析失败')
      }

      return { latest, release, versions: data.versions }
    } catch (error) {
      lastError = error
      logger.warn(`API 源 ${apiUrl} 请求失败:`, error.message || String(error))
      continue
    }
  }

  throw new Error(`所有 API 源均请求失败: ${lastError?.message || String(lastError)}`)
}

/**
 * 获取格式化的 Minecraft 版本信息
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
async function getVersionInfo() {
  try {
    const { latest, release } = await fetchVersions()
    const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN')

    return {
      success: true,
      data: `Minecraft 最新版本：\n正式版: ${release.id}(${formatDate(release.releaseTime)})\n快照版: ${latest.id}(${formatDate(latest.releaseTime)})`
    }
  } catch (error) {
    return {
      success: false,
      error: `版本信息获取失败：${error.message || String(error)}`
    }
  }
}

/**
 * 解析通知目标配置
 * @param target 格式: "platform:type:id"
 */
interface ParsedTarget {
  platform: string
  type: 'private' | 'group'
  id: string
}

function parseTarget(target: string): ParsedTarget | null {
  const parts = target.split(':')
  if (parts.length !== 3) return null

  const [platform, type, id] = parts
  if (!['private', 'group'].includes(type)) return null

  return { platform, type: type as 'private' | 'group', id }
}

/**
 * 向目标发送版本更新通知
 * @param {Context} ctx - Koishi 上下文
 * @param {string[]} targets - 目标配置列表 (格式: platform:type:id)
 * @param {string} updateMessage - 更新消息内容
 * @private
 */
async function notifyVersionUpdate(ctx: any, targets: string[], updateMessage: string) {
  for (const target of targets) {
    const parsed = parseTarget(target)
    if (!parsed) {
      logger.warn(`无效的通知目标配置: ${target}`)
      continue
    }

    for (const bot of ctx.bots) {
      if (bot.platform !== parsed.platform) continue

      try {
        if (parsed.type === 'private') {
          await bot.sendPrivateMessage(parsed.id, updateMessage)
        } else {
          await bot.sendMessage(parsed.id, updateMessage)
        }
      } catch (e) {
        logger.warn(`通知发送失败|${parsed.type} ${parsed.id}:`, e)
      }
    }
  }
}

/**
 * 检查 Minecraft 版本更新并发送通知
 * @param {{snapshot: string, release: string}} versions - 当前版本信息
 * @param {any} ctx - Koishi 上下文
 * @param {MTConfig} config - 插件配置
 * @returns {Promise<void>}
 */
async function checkUpdate(versions: { snapshot: string, release: string }, ctx: any, config: MTConfig) {
  try {
    const { latest, release } = await fetchVersions()
    const updates = [
      { type: 'snapshot', version: latest, enabled: config.tool.snapshot },
      { type: 'release', version: release, enabled: config.tool.release }
    ]

    for (const { type, version, enabled } of updates) {
      if (versions[type] && version.id !== versions[type] && enabled) {
        const msg = `Minecraft ${type === 'release' ? '正式版' : '快照版'}更新：${version.id}\n发布时间: ${new Date(version.releaseTime).toLocaleString('zh-CN')}`
        await notifyVersionUpdate(ctx, config.tool.guilds, msg)
      }
      versions[type] = version.id
    }
  } catch (error) {
    logger.warn('版本检查失败：', error)
  }
}

/**
 * 获取完整的玩家信息
 * @param {string} username - 玩家用户名
 * @returns {Promise<PlayerProfile>} 完整的玩家信息
 * @throws {Error} 当无法获取玩家信息时抛出错误
 */
async function getPlayerProfile(username: string): Promise<PlayerProfile> {
  try {
    // 获取基础信息
    const { data: basicData } = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!basicData) throw new Error('未找到该玩家信息');
    // 获取档案数据
    const { data: profileData } = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${basicData.id}`);
    // 解析材质信息
    let texturesData: TexturesData | null = null;
    if (profileData.properties?.[0]?.value) {
      texturesData = JSON.parse(Buffer.from(profileData.properties[0].value, 'base64').toString());
    }
    // 格式化UUID
    const uuidDashed = [
      basicData.id.slice(0, 8),
      basicData.id.slice(8, 12),
      basicData.id.slice(12, 16),
      basicData.id.slice(16, 20),
      basicData.id.slice(20)
    ].join('-');
    // 构建玩家档案
    const profile: PlayerProfile = {
      name: basicData.name,
      uuid: basicData.id,
      uuidDashed
    };
    // 添加皮肤和披风信息
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
    throw new Error(`玩家信息获取失败: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * 渲染玩家皮肤和披风，生成两个不同角度的视图
 * @param {Context} ctx - Koishi 上下文对象，用于获取 Puppeteer 实例
 * @param {string} skinUrl - 玩家皮肤的 URL 地址
 * @param {string} [capeUrl] - 玩家披风的 URL 地址（可选）
 * @param {boolean} [renderElytra=false] - 是否渲染鞘翅（需要披风）
 * @returns {Promise<string>} 返回渲染后的图片 Base64 编码字符串
 */
async function renderPlayerSkin(ctx: Context, skinUrl: string, capeUrl?: string, renderElytra: boolean = false): Promise<string> {
  // 确定渲染尺寸
  const viewportWidth = renderElytra ? 600 : (capeUrl ? 400 : 360);
  const viewportHeight = 400;
  const viewWidth = renderElytra ? 300 : (capeUrl ? 200 : 180);

  const page = await ctx.puppeteer.page()
  await page.setViewport({ width: viewportWidth, height: viewportHeight })

  const html = `
    <html>
      <head>
        <script src="https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js"></script>
        <style>
          body { margin: 0; background: transparent; display: flex; justify-content: center; align-items: center; }
          .container {
            display: flex;
            width: ${viewportWidth}px;
            height: ${viewportHeight}px;
          }
          .view { width: ${viewWidth}px; height: ${viewportHeight}px; }
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
              width: ${viewWidth},
              height: ${viewportHeight},
              preserveDrawingBuffer: true,
              fov: 30,
              zoom: 0.95
            });
            // 设置透明背景
            viewer.renderer.setClearColor(0x000000, 0);
            viewer.playerObject.rotation.y = rotationAngle;
            // 完全禁用动画
            viewer.animation = null;

            return viewer;
          };

          (async () => {
            // 创建左右两个视图，分别旋转 -36° 和 144° (-36° + 180°)
            const view1 = createView('view1', -Math.PI / 5);
            const view2 = createView('view2', Math.PI * 4 / 5);
            // 为每个视图加载皮肤和披风（如果有）
            for (const view of [view1, view2]) {
              await view.loadSkin("${skinUrl}");
              ${capeUrl ? `
              await view.loadCape("${capeUrl}");
              ${renderElytra ? 'view.playerObject.cape.visible = false; view.playerObject.elytra.visible = true;' : 'view.playerObject.cape.visible = true; view.playerObject.elytra.visible = false;'}
              ` : ''}
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

/**
 * 渲染玩家皮肤为大头娃娃风格（头大身小）
 * @param {Context} ctx - Koishi 上下文对象，用于获取 Puppeteer 实例
 * @param {string} skinUrl - 玩家皮肤的 URL 地址
 * @returns {Promise<string>} 返回渲染后的图片 Base64 编码字符串
 */
async function renderPlayerHead(ctx: Context, skinUrl: string): Promise<string> {
  const page = await ctx.puppeteer.page()
  await page.setViewport({ width: 400, height: 400 })

  const html = `
    <html>
      <head>
        <script src="https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js"></script>
        <style>
          body { margin: 0; background: transparent; display: flex; justify-content: center; align-items: center; }
          .container { width: 400px; height: 400px; }
        </style>
      </head>
      <body>
        <div class="container">
          <canvas id="view" width="400" height="400"></canvas>
        </div>
        <script>
          (async () => {
            const viewer = new skinview3d.SkinViewer({
              canvas: document.getElementById('view'),
              width: 400,
              height: 400,
              preserveDrawingBuffer: true,
              fov: 10,
              zoom: 1.0
            });
            // 设置透明背景
            viewer.renderer.setClearColor(0x000000, 0);

            await viewer.loadSkin("${skinUrl}");

            // 设置正面角度，稍微低头
            viewer.playerObject.rotation.x = 0.05;
            // 只放大头部，其他部位保持原比例
            viewer.playerObject.skin.head.scale.set(3.0, 3.0, 3.0);
            // 头部位置调整，补偿放大导致的偏移
            viewer.playerObject.skin.head.position.y = 0.5 * (3.0 - 1.0);
            // 整体模型缩放
            const globalScale = 0.6;
            viewer.playerObject.scale.set(globalScale, globalScale, globalScale);
            // 整体位置向下调整，使头部居中
            viewer.playerObject.position.y = -5;
            // 禁用动画，保持静态
            viewer.animation = null;
            viewer.render();
          })();
      </script>
      </body>
    </html>
  `

  await page.setContent(html)
  await page.waitForFunction(() => {
    const canvas = document.getElementById('view');
    return canvas && (canvas as HTMLCanvasElement).toDataURL() !== 'data:,';
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

/**
 * 注册 Minecraft 服务器信息查询和皮肤查询命令
 * @param {Context} ctx - Koishi 上下文
 * @param {Command} parent - 父命令
 * @param {MTConfig} config - 插件配置
 * @returns {NodeJS.Timeout|undefined} - 定时器句柄（如启用版本检查）
 */
export function registerInfoCommands(ctx: Context, parent: any, config: MTConfig): NodeJS.Timeout | undefined {
  // 创建一个对象保存版本信息
  const minecraftVersions = { snapshot: '', release: '' }

  const mcinfo = parent.subcommand('.info [server]', '查询 Minecraft 服务器信息')
    .usage(`mc.info [地址[:端口]] - 查询 Java 版服务器\nmc.info.be [地址[:端口]] - 查询 Bedrock 版服务器`)
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || config.tool.default, 'java', config)
        return formatServerStatus(status, config.tool)
      } catch (error) {
        return error.message
      }
    })

  mcinfo.subcommand('.be [server]', '查询 Bedrock 版服务器')
    .usage('mc.info.be [地址[:端口]] - 查询 Bedrock 版服务器状态')
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || config.tool.default, 'bedrock', config)
        return formatServerStatus(status, config.tool)
      } catch (error) {
        return error.message
      }
    })

  // 添加版本查询命令
  parent.subcommand('.ver', '查询 Minecraft 版本信息')
    .usage('mc.ver - 获取 Minecraft 最新版本信息')
    .action(async () => {
      const result = await getVersionInfo()
      return result.success ? result.data : result.error
    })

  // 添加皮肤查询命令
  parent.subcommand('.skin <username>', '查询 Minecraft 玩家信息')
    .usage('mc.skin <用户名> [-e/-c] - 获取玩家信息并生成皮肤预览，可选显示鞘翅或披风')
    .option('elytra', '-e 显示鞘翅')
    .option('cape', '-c 显示披风')
    .action(async ({ options }, username) => {
      if (!username) return '请输入玩家用户名'

      try {
        const profile = await getPlayerProfile(username);
        const parts = [
          `${profile.name}[${profile.uuidDashed}]`
        ];

        if (profile.skin) {
          const renderCape = Boolean(options.cape && profile.cape?.url);
          const renderElytra = Boolean(options.elytra && profile.cape?.url);
          const capeUrl = (renderCape || renderElytra) ? profile.cape?.url : undefined;

          const skinImage = await renderPlayerSkin(ctx, profile.skin.url, capeUrl, renderElytra);
          parts.push(h.image(`data:image/png;base64,${skinImage}`).toString());

          if (config.tool.showSkull) {
            parts.push(`使用 /give 获取 ${profile.name} ${profile.skin ? `(${profile.skin.model === 'slim' ? '纤细' : '经典'}) ` : ''}的头：(≤1.12 & ≥1.13)`);
            parts.push(`minecraft:skull 1 3 {SkullOwner:"${profile.name}"}`);
            parts.push(`minecraft:player_head{SkullOwner:"${profile.name}"}`);
          }
        } else {
          parts.push('该玩家未设置皮肤');
        }
        return parts.join('\n');
      } catch (error) {
        return error.message
      }
    })
    .subcommand('.head <username>', '获取 Minecraft 玩家大头')
    .usage('mc.skin.head <用户名> - 获取玩家大头娃娃风格头像')
    .action(async ({ }, username) => {
      if (!username) return '请输入玩家用户名'

      try {
        const profile = await getPlayerProfile(username);
        const parts = [];

        if (profile.skin) {
          const headImage = await renderPlayerHead(ctx, profile.skin.url);
          parts.push(h.image(`data:image/png;base64,${headImage}`).toString());
        } else {
          parts.push('该玩家未设置皮肤');
        }
        return parts.join('\n');
      } catch (error) {
        return error.message
      }
    });

  // 如果启用了版本更新检查，启动定时任务
  if (config.tool.versionCheck && config.tool.guilds.length) {
    checkUpdate(minecraftVersions, ctx, config)
    const timer = setInterval(() => checkUpdate(minecraftVersions, ctx, config), config.tool.interval * 60 * 1000)
    return timer
  }
}
