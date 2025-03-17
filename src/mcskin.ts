import { Context } from 'koishi'
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
async function renderPlayerSkin(ctx: Context, skinUrl: string, capeUrl?: string): Promise<string> {
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

import { h } from 'koishi'
import { MinecraftToolsConfig } from './index'

/**
 * 注册 Minecraft 皮肤查询命令
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - Minecraft 工具配置
 */
export function registerSkinCommands(ctx: Context, config: MinecraftToolsConfig) {
  ctx.command('mcskin <username>', '查询 Minecraft 玩家信息')
    .usage('mcskin <用户名> - 获取玩家信息并生成皮肤及披风预览')
    .action(async ({ }, username) => {
      if (!username) return '请输入玩家用户名'

      try {
        const profile = await getPlayerProfile(username);
        const parts = [
          `${profile.name}[${profile.uuidDashed}]`
        ];

        if (profile.skin) {
          const skinImage = await renderPlayerSkin(ctx, profile.skin.url, profile.cape?.url);
          parts.push(h.image(`data:image/png;base64,${skinImage}`).toString());

          if (config.info.showSkull) {
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
    });
}
