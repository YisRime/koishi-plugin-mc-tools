import { Context } from 'koishi'
import axios from 'axios'
import { MinecraftToolsConfig } from './index'

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
