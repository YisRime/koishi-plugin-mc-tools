import { Context, h } from 'koishi'
import { MTConfig } from './index'
import axios from 'axios'

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
 * 注册 Minecraft 皮肤查询命令
 * @param {Context} ctx - Koishi 上下文
 * @param {Command} parent - 父命令
 * @param {MTConfig} config - Minecraft 工具配置
 */
export function registerSkinCommands(ctx: Context, parent: any, config: MTConfig) {
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

          if (config.specific.showSkull) {
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
}
