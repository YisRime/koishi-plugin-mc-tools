import { h, Context } from 'koishi'
import axios from 'axios'
import { MTConfig } from './index'

interface MinecraftTexturesData {
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

interface MinecraftPlayerProfile {
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
 * 获取玩家信息
 */
async function fetchPlayerProfile(username: string): Promise<MinecraftPlayerProfile> {
  try {
    // 获取基础信息
    const { data: playerData } = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!playerData) throw new Error('未找到该玩家信息');

    // 获取档案数据
    const { data: profileData } = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${playerData.id}`);

    // 解析材质信息
    let texturesData: MinecraftTexturesData | null = null;
    if (profileData.properties?.[0]?.value) {
      texturesData = JSON.parse(Buffer.from(profileData.properties[0].value, 'base64').toString());
    }

    // 格式化UUID
    const uuidDashed = playerData.id.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, '$1-$2-$3-$4-$5');

    // 构建玩家档案
    const profile: MinecraftPlayerProfile = {
      name: playerData.name,
      uuid: playerData.id,
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
 * 渲染玩家皮肤和披风
 */
async function renderPlayerSkin(ctx: Context, skinUrl: string, capeUrl?: string, renderElytra: boolean = false): Promise<string> {
  // 根据渲染内容确定尺寸
  const viewportWidth = renderElytra ? 600 : (capeUrl ? 400 : 360);
  const viewHeight = 400;
  const skinViewWidth = renderElytra ? 300 : (capeUrl ? 200 : 180);

  const page = await ctx.puppeteer.page()
  await page.setViewport({ width: viewportWidth, height: viewHeight })

  const html = `
    <html>
      <head>
        <script src="https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js"></script>
        <style>
          body { margin: 0; background: transparent; display: flex; justify-content: center; align-items: center; }
          .container { display: flex; width: ${viewportWidth}px; height: ${viewHeight}px; }
          .view { width: ${skinViewWidth}px; height: ${viewHeight}px; }
        </style>
      </head>
      <body>
        <div class="container">
          <canvas id="view1" class="view"></canvas>
          <canvas id="view2" class="view"></canvas>
        </div>
        <script>
          const createSkinViewer = (id, angle) => {
            const viewer = new skinview3d.SkinViewer({
              canvas: document.getElementById(id),
              width: ${skinViewWidth},
              height: ${viewHeight},
              preserveDrawingBuffer: true,
              fov: 30,
              zoom: 0.95
            });
            viewer.renderer.setClearColor(0x000000, 0);
            viewer.playerObject.rotation.y = angle;
            viewer.animation = null;
            return viewer;
          };
          (async () => {
            const frontView = createSkinViewer('view1', -Math.PI / 5);
            const backView = createSkinViewer('view2', Math.PI * 4 / 5);
            for (const view of [frontView, backView]) {
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
    const v1 = document.getElementById('view1');
    const v2 = document.getElementById('view2');
    return v1 && v2 &&
           (v1 as HTMLCanvasElement).toDataURL() !== 'data:,' &&
           (v2 as HTMLCanvasElement).toDataURL() !== 'data:,';
  }, { timeout: 5000 })

  await new Promise(resolve => setTimeout(resolve, 100))
  const element = await page.$('.container')
  const screenshot = await element.screenshot({
    encoding: 'base64',
    omitBackground: true
  })
  await page.close()
  return screenshot
}

/**
 * 渲染玩家大头娃娃
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
        <div class="container"><canvas id="view" width="400" height="400"></canvas></div>
        <script>
          (async () => {
            const viewer = new skinview3d.SkinViewer({
              canvas: document.getElementById('view'),
              width: 400, height: 400,
              preserveDrawingBuffer: true,
              fov: 10, zoom: 1.0
            });
            viewer.renderer.setClearColor(0x000000, 0);
            await viewer.loadSkin("${skinUrl}");
            // 设置角度和缩放
            viewer.playerObject.rotation.x = 0.05;
            viewer.playerObject.skin.head.scale.set(3.0, 3.0, 3.0);
            viewer.playerObject.skin.head.position.y = 0.5 * (3.0 - 1.0);
            // 整体缩放和位置调整
            const globalScale = 0.6;
            viewer.playerObject.scale.set(globalScale, globalScale, globalScale);
            viewer.playerObject.position.y = -5;
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
  const element = await page.$('.container')
  const screenshot = await element.screenshot({
    encoding: 'base64',
    omitBackground: true
  })
  await page.close()
  return screenshot
}

/**
 * 注册皮肤相关命令
 */
export function registerSkin(ctx: Context, parent: any, config: MTConfig) {
  parent.subcommand('.skin <username>', '查询 Minecraft 玩家皮肤')
    .option('elytra', '-e 显示鞘翅')
    .option('cape', '-c 显示披风')
    .action(async ({ options }, username) => {
      if (!username) return '请输入玩家用户名'
      try {
        const profile = await fetchPlayerProfile(username);
        const parts = [`${profile.name}[${profile.uuidDashed}]`];

        if (profile.skin) {
          const showCape = Boolean(options.cape && profile.cape?.url);
          const showElytra = Boolean(options.elytra && profile.cape?.url);
          const capeUrl = (showCape || showElytra) ? profile.cape?.url : undefined;
          const skinImage = await renderPlayerSkin(ctx, profile.skin.url, capeUrl, showElytra);
          parts.push(h.image(`data:image/png;base64,${skinImage}`).toString());

          if (config.showSkull) {
            const modelType = profile.skin.model === 'slim' ? '纤细' : '经典';
            parts.push(`使用 /give 获取 ${profile.name} (${modelType}) 的头：(≤1.12 & ≥1.13)`);
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

    .subcommand('.head <username>', '获取 Minecraft 玩家头像')
    .action(async ({}, username) => {
      if (!username) return '请输入玩家用户名'
      try {
        const profile = await fetchPlayerProfile(username);
        if (!profile.skin) return '该玩家未设置皮肤';
        const headImage = await renderPlayerHead(ctx, profile.skin.url);
        return h.image(`data:image/png;base64,${headImage}`).toString();
      } catch (error) {
        return error.message
      }
    });
}