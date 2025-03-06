import { Context } from 'koishi'
import axios from 'axios'
import { MinecraftToolsConfig } from './index'

declare global {
  interface Window {
    skinview3d: {
      SkinViewer: new (options: {
        canvas: HTMLCanvasElement
        width: number
        height: number
        preserveDrawingBuffer: boolean
        fov: number
        zoom: number
      }) => {
        renderer: { setClearColor: (color: number, alpha: number) => void }
        playerObject: { rotation: { y: number } }
        animation: any
        loadSkin: (url: string) => Promise<void>
        loadCape: (url: string) => Promise<void>
        render: () => void
      }
    }
  }
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
    throw new Error('版本数据解析失败')
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
      ctx.logger('mc-tools').warn(`无效的通知目标配置: ${target}`)
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
        ctx.logger('mc-tools').warn(`通知发送失败（${parsed.type} ${parsed.id}）:`, e)
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
        const msg = `Minecraft ${type === 'release' ? '正式版' : '快照版'}更新：${version.id}\n发布时间: ${new Date(version.releaseTime).toLocaleString('zh-CN')}`
        await notifyVersionUpdate(ctx, config.ver.groups, msg)
      }
      versions[type] = version.id
    }
  } catch (error) {
    ctx.logger('mc-tools').warn('版本检查失败：', error)
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
    if (!basicData) throw new Error('未找到该玩家信息');

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
      throw new Error('玩家信息不存在');
    }
    if (error.response?.status === 400) {
      throw new Error('UUID 格式不正确');
    }
    if (error.response?.status === 204) {
      throw new Error('UUID 未关联玩家信息');
    }
    if (error.response?.status === 429) {
      throw new Error('请求频率超出限制');
    }
    throw new Error(`玩家信息获取失败: ${error.response?.data?.error || error.message}`);
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

  const base64Image = await page.evaluate(async ([skinUrl, capeUrl]) => {
    const container = document.createElement('div')
    container.style.cssText = 'display:flex;width:400px;height:400px;'

    const view1 = document.createElement('canvas')
    const view2 = document.createElement('canvas')
    view1.width = view2.width = 200
    view1.height = view2.height = 400
    container.appendChild(view1)
    container.appendChild(view2)
    document.body.appendChild(container)

    await new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = 'https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js'
      script.onload = resolve
      document.head.appendChild(script)
    })

    const createView = (canvas: HTMLCanvasElement, rotationAngle: number) => {
      const viewer = new window.skinview3d.SkinViewer({
        canvas,
        width: 200,
        height: 400,
        preserveDrawingBuffer: true,
        fov: 30,
        zoom: 0.48
      })

      viewer.renderer.setClearColor(0x000000, 0)
      viewer.playerObject.rotation.y = rotationAngle
      viewer.animation = null

      return viewer
    }

    const viewer1 = createView(view1, -Math.PI / 5)
    const viewer2 = createView(view2, Math.PI * 4 / 5)

    for (const viewer of [viewer1, viewer2]) {
      await viewer.loadSkin(skinUrl)
      if (capeUrl) await viewer.loadCape(capeUrl)
      viewer.render()
    }

    const finalCanvas = document.createElement('canvas')
    finalCanvas.width = 400
    finalCanvas.height = 400
    const ctx = finalCanvas.getContext('2d')
    ctx.drawImage(view1, -100, -195)
    ctx.drawImage(view2, 100, -195)

    return finalCanvas.toDataURL('image/png')
  }, [skinUrl, capeUrl])

  await page.close()
  return base64Image.split(',')[1]
}
