import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import {
  MinecraftToolsConfig,
  MINECRAFT_LANGUAGES,
  LangCode,
  checkServerStatus,
  getVersionInfo,
  checkUpdate,
  formatErrorMessage
} from './utils'
import { fetchModContent, formatContent } from './modwiki'
import { processWikiRequest } from './mcwiki'
import { searchMod, search, capture } from './subwiki'
import { getPlayerProfile, renderPlayerSkin } from './utils'
import { searchMods, getModDetails, formatSearchResults } from './mod'

/**
 * Minecraft 工具箱插件
 * @module mc-tools
 */
export const name = 'mc-tools'
export const inject = {optional: ['puppeteer']}
export const usage = '使用 Docker 部署的用户请安装 chromium-swiftshader 来使用 mcskin 指令获取皮肤'

/**
 * 插件配置模式
 */
export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    totalLength: Schema.number()
      .default(400)
      .description('总预览字数'),
    descLength: Schema.number()
      .default(20)
      .description('搜索项目描述字数'),
    Timeout: Schema.number()
      .default(15)
      .description('搜索超时时间（秒）')
  }).description('通用设置'),

  search: Schema.object({
    Language: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .default('zh')
      .description('Wiki 显示语言'),
    sectionLength: Schema.number()
      .default(50)
      .description('Wiki 每段预览字数'),
    linkCount: Schema.number()
      .default(4)
      .description('相关链接最大显示数'),
    cfApi: Schema.string()
      .role('secret')
      .description('CurseForge API Key')
  }).description('查询设置'),

  info: Schema.object({
    default: Schema.string()
      .description('INFO 默认服务器')
      .default('localhost:25565'),
    showIcon: Schema.boolean()
      .default(true)
      .description('显示服务器图标'),
    showPlayers: Schema.boolean()
      .default(true)
      .description('显示在线玩家列表')
  }).description('服务器设置'),

  ver: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用版本更新检查'),
    release: Schema.boolean()
      .default(true)
      .description('通知正式版本'),
    snapshot: Schema.boolean()
      .default(true)
      .description('通知快照版本'),
    interval: Schema.number()
      .default(60)
      .description('检查间隔时间（分钟）'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('接收更新通知 ID')
  }).description('更新检测设置')
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, pluginConfig: MinecraftToolsConfig) {
  const userLanguageSettings = new Map<string, LangCode>()
  const minecraftVersions = { snapshot: '', release: '' }
  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`mcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图`)

  mcwiki.action(async ({ session }, keyword) => {
    try {
      const result = await processWikiRequest(keyword, session.userId, pluginConfig, userLanguageSettings)
      return result
    } catch (error) {
      return error.message
    }
  })

  const modWikiCommand = ctx.command('modwiki <keyword:text>', 'MCMOD 查询')
    .usage(`modwiki <关键词> - 直接查询内容\nmodwiki.search <关键词> - 搜索并选择条目\nmodwiki.shot <关键词> - 获取页面截图`)
    .action(async ({ }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMod(keyword, pluginConfig)
        if (!results.length) return '未找到相关内容'

        const result = results[0]
        const content = await fetchModContent(result.url, pluginConfig.wiki)
        return formatContent(content, result.url, {
          showLinks: pluginConfig.search.linkCount
        })
      } catch (error) {
        return error.message
      }
    })

    mcwiki.subcommand('.search <keyword:text>', '搜索 Wiki 页面（使用 -i 后缀以获取页面截图）')
    .action(async ({ session }, keyword) => {
      return await search({
        keyword,
        source: 'wiki',
        session,
        config: pluginConfig,
        ctx,
        lang: userLanguageSettings.get(session.userId) || pluginConfig.search.Language
      })
    })

  modWikiCommand.subcommand('.search <keyword:text>', '搜索 MCMOD 页面（使用 -i 后缀以获取页面截图）')
    .action(async ({ session }, keyword) => {
      return await search({
        keyword,
        source: 'mcmod',
        session,
        config: pluginConfig,
        ctx
      })
    })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const wikiResult = await processWikiRequest(keyword, session.userId, pluginConfig, userLanguageSettings, 'image') as any
        if (typeof wikiResult === 'string') return wikiResult

        await session.send(`正在获取页面...\n完整内容：${wikiResult.url}`)
        const result = await capture(
          wikiResult.pageUrl,
          pluginConfig,
          ctx,
          {
            type: 'wiki',
            lang: userLanguageSettings.get(session.userId) || pluginConfig.search.Language
          }
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })

  modWikiCommand.subcommand('.shot <keyword:text>', '搜索并截图MCMOD条目')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMod(keyword, pluginConfig)
        if (!results.length) throw new Error('未找到相关内容')
        const targetUrl = results[0].url

        await session.send(`正在获取页面...\n完整内容：${targetUrl}`)
        const result = await capture(
          targetUrl,
          pluginConfig,
          ctx,
          { type: 'mcmod' }
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })

  ctx.command('mcver', '获取 Minecraft 最新版本')
    .action(async () => {
      const result = await getVersionInfo()
      return result.success ? result.data : result.error
    })

  if (pluginConfig.ver.enabled && pluginConfig.ver.groups.length) {
    checkUpdate(minecraftVersions, ctx, pluginConfig)
    setInterval(() => checkUpdate(minecraftVersions, ctx, pluginConfig), pluginConfig.ver.interval * 60 * 1000)
  }

  ctx.command('mcinfo [server]', '查询 MC 服务器状态')
    .usage('mcinfo [地址[:端口]] - 查询服务器状态')
    .example('mcinfo mc.example.com:25566 - 查询指定端口的服务器')
    .action(async ({ }, server) => {
      try {
        return await checkServerStatus(server, pluginConfig)
      } catch (error) {
        return formatErrorMessage(error)
      }
    })

  ctx.command('mcskin <username>', '查询 Minecraft 玩家信息')
    .usage('mcskin <用户名> - 获取玩家信息和3D皮肤预览')
    .example('mcskin Notch - 获取 Notch 的信息')
    .action(async ({ }, username) => {
      if (!username) return '请输入要查询的用户名';

      try {
        const profile = await getPlayerProfile(username);
        const parts = [
          `${profile.name}[${profile.uuidDashed}]${profile.skin ? ` (${profile.skin.model === 'slim' ? '纤细' : '经典'})` : ''}`
        ];

        if (profile.skin) {
          const skinImage = await renderPlayerSkin(ctx, profile.skin.url, profile.cape?.url);
          parts.push(h.image(`data:image/png;base64,${skinImage}`).toString());
          parts.push(`获取 ${profile.name} 的头(≤1.12 或 ≥1.13):`);
          parts.push(`/give @p minecraft:skull 1 3 {SkullOwner:"${profile.name}"}`);
          parts.push(`/give @p minecraft:player_head{SkullOwner:"${profile.name}"}`);
        } else {
          parts.push('未设置皮肤');
        }
        return parts.join('\n');
      } catch (error) {
        return error.message
      }
    })

  const modrCommand = ctx.command('modmr <keyword> [type]', 'Modrinth 项目搜索')
    .usage('modmr <关键词> [type] - 获取项目的详细信息\ntype: mod, resourcepack, datapack, shader, modpack, plugin')
    .example('modmr fabric - 搜索所有类型的 Fabric 相关项目')
    .example('modmr fabric mod - 只搜索 Fabric 相关模组')
    .action(async ({ }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', undefined, type)
        if (!results.length) return '未找到相关项目'
        return await getModDetails(results[0], pluginConfig.search.cfApi, pluginConfig.wiki.totalLength)
      } catch (error) {
        return error.message
      }
    })

  modrCommand.subcommand('.search <keyword> [type]', '搜索 Modrinth 项目')
    .usage('modmr.search <关键词> [type] - 搜索并列出多个结果\ntype 可选值: mod, resourcepack, datapack, shader, modpack, plugin')
    .example('modmr.search fabric - 搜索所有类型的 Fabric 相关项目')
    .example('modmr.search fabric mod - 只搜索 Fabric 相关模组')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', undefined, type)
        if (!results.length) return '未找到相关项目'

        await session.send('Modrinth 搜索结果：\n' + formatSearchResults(results, pluginConfig.wiki.descLength) + '\n请回复序号查看详细内容')

        const response = await session.prompt(pluginConfig.wiki.Timeout * 1000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        return await getModDetails(results[index], pluginConfig.search.cfApi, pluginConfig.wiki.totalLength)
      } catch (error) {
        return error.message
      }
    })

  const modcfCommand = ctx.command('modcf <keyword> [type]', 'CurseForge 项目搜索')
    .usage('modcf <关键词> [type] - 获取项目的详细信息\ntype: mod, resourcepack, modpack, shader, datapack, world, addon, plugin')
    .example('modcf fabric - 搜索所有类型的 Fabric 相关项目')
    .example('modcf fabric mod - 只搜索 Fabric 相关模组')
    .action(async ({ }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', pluginConfig.search.cfApi, type)
        if (!results.length) return '未找到相关项目'
        return await getModDetails(results[0], pluginConfig.search.cfApi, pluginConfig.wiki.totalLength)
      } catch (error) {
        return error.message
      }
    })

  modcfCommand.subcommand('.search <keyword> [type]', '搜索 CurseForge 项目')
    .usage('modcf.search <关键词> [type] - 搜索并列出多个结果\n可用类型: mod, resourcepack, modpack, shader, datapack, scenario, world, addon, game, plugin, skin, tool, shader-port, script')
    .example('modcf.search fabric - 搜索所有类型的 Fabric 相关项目')
    .example('modcf.search fabric mod - 只搜索 Fabric 相关模组')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', pluginConfig.search.cfApi, type)
        if (!results.length) return '未找到相关项目'

        await session.send('CurseForge 搜索结果：\n' + formatSearchResults(results, pluginConfig.wiki.descLength) + '\n请回复序号查看详细内容')

        const response = await session.prompt(pluginConfig.wiki.Timeout * 1000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        return await getModDetails(results[index], pluginConfig.search.cfApi, pluginConfig.wiki.totalLength)
      } catch (error) {
        return error.message
      }
    })
}
