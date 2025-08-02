import { h, Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

/**
 * Minecraft玩家配置文件接口
 * @interface MinecraftPlayerProfile
 * @property {string} name - 玩家用户名
 * @property {string} uuid - 玩家UUID（不带破折号）
 * @property {string} uuidDashed - 玩家UUID（带破折号的格式）
 * @property {Object} [skin] - 玩家皮肤信息
 * @property {string} skin.url - 皮肤URL
 * @property {'slim'|'classic'} skin.model - 皮肤模型类型
 * @property {Object} [cape] - 玩家披风信息
 * @property {string} cape.url - 披风URL
 */
interface MinecraftPlayerProfile {
  name: string
  uuid: string
  uuidDashed: string
  skin?: { url: string, model: 'slim' | 'classic' }
  cape?: { url: string }
}

/**
 * 从Mojang API获取玩家配置文件
 * @param {Context} ctx - Koishi上下文
 * @param {string} username - Minecraft用户名
 * @returns {Promise<MinecraftPlayerProfile>} 玩家配置文件
 * @throws {Error} 获取失败时抛出错误
 */
async function fetchPlayerProfile(ctx: Context, username: string): Promise<MinecraftPlayerProfile> {
  try {
    const playerData = await ctx.http.get(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    const profileData = await ctx.http.get(`https://sessionserver.mojang.com/session/minecraft/profile/${playerData.id}`);
    const texturesData = profileData.properties?.[0]?.value ?
      JSON.parse(Buffer.from(profileData.properties[0].value, 'base64').toString()) : null;
    const profile: MinecraftPlayerProfile = {
      name: playerData.name, uuid: playerData.id,
      uuidDashed: playerData.id.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, '$1-$2-$3-$4-$5')
    };
    // 添加皮肤信息
    if (texturesData?.textures?.SKIN) {
      profile.skin = {
        url: texturesData.textures.SKIN.url,
        model: texturesData.textures.SKIN.metadata?.model || 'classic'
      };
    }
    // 添加披风信息
    if (texturesData?.textures?.CAPE) profile.cape = { url: texturesData.textures.CAPE.url };
    return profile;
  } catch (error) {
    ctx.logger.error(`玩家信息获取失败: ${error.message}`, error);
  }
}

/**
 * 使用Puppeteer渲染HTML并截图
 * @param {Context} ctx - Koishi上下文
 * @param {string} html - 要渲染的HTML内容
 * @param {string} selector - 要截图的元素选择器
 * @returns {Promise<string>} Base64编码的图像数据
 */
async function renderWithPuppeteer(ctx: Context, html: string, selector: string): Promise<string> {
  const page = await ctx.puppeteer.page();
  await page.setContent(html);
  await page.waitForFunction(
    s => document.querySelector(s) && Array.from(document.querySelectorAll('canvas'))
      .every(c => (c as HTMLCanvasElement).toDataURL() !== 'data:,'),
    { timeout: 5000 }, selector
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  const screenshot = await (await page.$(selector)).screenshot({ encoding: 'base64', omitBackground: true });
  await page.close();
  return screenshot;
}

/**
 * 渲染玩家皮肤模型
 * @param {Context} ctx - Koishi上下文
 * @param {string} skinUrl - 皮肤URL
 * @param {string} [capeUrl] - 可选的披风URL
 * @param {boolean} [renderElytra=false] - 是否渲染鞘翅而非披风
 * @param {string} [backgroundColor] - 背景颜色
 * @returns {Promise<string>} Base64编码的图像数据
 */
async function renderPlayerSkin(ctx: Context, skinUrl: string, capeUrl?: string, renderElytra: boolean = false, backgroundColor?: string): Promise<string> {
  const viewportWidth = renderElytra ? 600 : (capeUrl ? 400 : 360);
  const skinViewWidth = renderElytra ? 300 : (capeUrl ? 200 : 180);
  const capeCode = capeUrl ? `
    await view.loadCape("${capeUrl}");
    ${renderElytra ? 'view.playerObject.cape.visible = false; view.playerObject.elytra.visible = true;' : 'view.playerObject.cape.visible = true; view.playerObject.elytra.visible = false;'}
  ` : '';
  const backgroundStyle = backgroundColor ? `background:${backgroundColor};` : `background:transparent;`;
  const html = `<html><head>
    <script src="https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js"></script>
    <style>body{margin:0;${backgroundStyle}display:flex;justify-content:center;align-items:center}.container{display:flex;width:${viewportWidth}px;height:400px}.view{width:${skinViewWidth}px;height:400px}</style>
    </head><body><div class="container">
    <canvas id="view1" class="view"></canvas><canvas id="view2" class="view"></canvas></div>
    <script>(async()=>{
      const createViewer=(id,angle)=>{
        const v=new skinview3d.SkinViewer({canvas:document.getElementById(id),width:${skinViewWidth},height:400,preserveDrawingBuffer:true,fov:30,zoom:0.95});
        v.renderer.setClearColor(0x000000,0);v.playerObject.rotation.y=angle;v.animation=null;return v;
      };
      const views=[createViewer('view1',-Math.PI/5),createViewer('view2',Math.PI*4/5)];
      for(const view of views){
        await view.loadSkin("${skinUrl}");${capeCode}
        view.render();
      }
    })()</script></body></html>`;
  return renderWithPuppeteer(ctx, html, '.container');
}

/**
 * 渲染玩家头像
 * @param {Context} ctx - Koishi上下文
 * @param {string} skinUrl - 皮肤URL
 * @param {string} [backgroundColor] - 背景颜色
 * @returns {Promise<string>} Base64编码的图像数据
 */
async function renderPlayerHead(ctx: Context, skinUrl: string, backgroundColor?: string): Promise<string> {
  const backgroundStyle = backgroundColor ? `background:${backgroundColor};` : `background:transparent;`;
  const html = `<html><head>
    <script src="https://unpkg.com/skinview3d@3.1.0/bundles/skinview3d.bundle.js"></script>
    <style>body{margin:0;${backgroundStyle}display:flex;justify-content:center;align-items:center}.container{width:400px;height:400px}</style>
    </head><body><div class="container"><canvas id="view" width="400" height="400"></canvas></div>
    <script>(async()=>{
      const viewer=new skinview3d.SkinViewer({canvas:document.getElementById('view'),width:400,height:400,preserveDrawingBuffer:true,fov:10,zoom:1.0});
      viewer.renderer.setClearColor(0x000000,0);
      await viewer.loadSkin("${skinUrl}");
      viewer.playerObject.rotation.x=0.05;
      viewer.playerObject.skin.head.scale.set(3.0,3.0,3.0);
      viewer.playerObject.skin.head.position.y=1.0;
      viewer.playerObject.scale.set(0.6,0.6,0.6);
      viewer.playerObject.position.y=-5;
      viewer.animation=null;
      viewer.render();
    })()</script></body></html>`;
  return renderWithPuppeteer(ctx, html, '.container');
}

/**
 * 注册玩家相关命令
 * @param {Context} ctx - Koishi上下文
 * @param {any} parent - 父命令
 */
export function registerPlayer(ctx: Context, parent: any) {
  const player = parent.subcommand('.player <username>', '查询 Minecraft 玩家信息')
    .action(async ({}, username) => {
      if (!username) return '请输入玩家用户名';
      try {
        const profile = await fetchPlayerProfile(ctx, username);
        const modelType = profile.skin.model === 'slim' ? '纤细' : '经典';
        return h('message', [
          h.text(`\n玩家: ${profile.name} [${modelType}] `), profile.cape && h.text('披风'),
          h.text(`\nUUID: ${profile.uuidDashed}`),
          h.text('\n在游戏中使用 "/give @p minecraft:xxx" 来获取玩家头颅'),
          h.text(`\n1.12及之前:skull 1 3 {SkullOwner:"${profile.name}"}`),
          h.text(`\n1.13及之后:player_head{SkullOwner:"${profile.name}"}`)
        ]);
      } catch (error) {
        ctx.logger.error(`查询玩家信息失败: ${error.message}`, error);
        return `查询玩家信息失败: ${error.message}`;
      }
    });
  player.subcommand('.skin <username>', '获取玩家皮肤预览')
    .option('elytra', '-e 显示鞘翅')
    .option('cape', '-c 不显示披风')
    .option('bg', '-b <color:string> 设置背景色(HEX)')
    .action(async ({ options }, username) => {
      if (!username) return '请输入玩家用户名';
      try {
        const profile = await fetchPlayerProfile(ctx, username);
        const showCape = Boolean(!options.cape && profile.cape?.url);
        const showElytra = Boolean(options.elytra && profile.cape?.url);
        const skinImage = await renderPlayerSkin(ctx, profile.skin.url, (showCape || showElytra) ? profile.cape?.url : undefined, showElytra, options.bg);
        return h.image(`data:image/png;base64,${skinImage}`);
      } catch (error) {
        ctx.logger.error(`获取玩家皮肤预览失败: ${error.message}`, error);
        return `获取玩家皮肤失败: ${error.message}`;
      }
    });
  player.subcommand('.head <username>', '获取玩家大头娃娃')
    .option('bg', '-b <color:string> 设置背景色(HEX)')
    .action(async ({ options }, username) => {
      if (!username) return '请输入玩家用户名';
      try {
        const profile = await fetchPlayerProfile(ctx, username);
        return h.image(`data:image/png;base64,${await renderPlayerHead(ctx, profile.skin.url, options.bg)}`);
      } catch (error) {
        ctx.logger.error(`获取玩家大头娃娃失败: ${error.message}`, error);
        return `获取玩家皮肤失败: ${error.message}`;
      }
    });
  player.subcommand('.raw <username>', '获取玩家原始皮肤')
    .action(async ({}, username) => {
      if (!username) return '请输入玩家用户名';
      try {
        const profile = await fetchPlayerProfile(ctx, username);
        return h.image(profile.skin.url);
      } catch (error) {
        ctx.logger.error(`获取玩家原始皮肤失败: ${error.message}`, error);
        return `获取玩家皮肤失败: ${error.message}`;
      }
    });
}
