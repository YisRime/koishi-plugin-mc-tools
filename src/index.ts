import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import {
  MinecraftToolsConfig,
  MINECRAFT_LANGUAGES,
  LangCode,
  checkServerStatus,
  getVersionInfo,
  checkUpdate,
  formatErrorMessage,
} from './utils'
import { fetchModContent, formatContent } from './modwiki'
import { processWikiRequest } from './mcwiki'
import { searchMod, search, capture } from './subwiki'

/**
 * Minecraft 工具箱插件
 * @module mc-tools
 */
export const name = 'mc-tools'
export const inject = {optional: ['puppeteer']}

/**
 * 插件配置模式
 */
export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    defaultLanguage: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .default('zh')
      .description('Wiki 显示语言'),
    minSectionLength: Schema.number()
      .default(12)
      .description('Wiki 段落最小字数'),
    sectionPreviewLength: Schema.number()
      .default(50)
      .description('Wiki 段落预览字数'),
    totalPreviewLength: Schema.number()
      .default(500)
      .description('总预览字数'),
    showVersions: Schema.boolean()
      .default(true)
      .description('显示支持版本'),
    showLinks: Schema.boolean()
      .default(true)
      .description('显示相关链接'),
    showDescription: Schema.boolean()
      .default(true)
      .description('显示简介'),
    imageEnabled: Schema.boolean()
      .default(true)
      .description('显示图片'),
    searchTimeout: Schema.number()
      .default(15)
      .description('搜索选择时间（秒）'),
    searchDescLength: Schema.number()
      .default(20)
      .description('搜索结果描述字数(设置为0关闭描述)'),
  }).description('Wiki & MCMOD 设置'),

  versionCheck: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用版本更新检查'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('接收版本更新通知 ID'),
    interval: Schema.number()
      .default(60)
      .description('版本检查间隔时间（分钟）'),
    notifyOnRelease: Schema.boolean()
      .default(true)
      .description('正式版本更新通知'),
    notifyOnSnapshot: Schema.boolean()
      .default(true)
      .description('快照版本更新通知')
  }).description('Version 设置'),

  server: Schema.object({
    address: Schema.string()
      .description('默认服务器地址:端口')
      .default('localhost:25565'),
    showIcon: Schema.boolean()
      .default(true)
      .description('显示服务器图标'),
    showPlayers: Schema.boolean()
      .default(true)
      .description('显示在线玩家')
  }).description('Info 设置')
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
        return formatContent(content, result.url)
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
        lang: userLanguageSettings.get(session.userId) || pluginConfig.wiki.defaultLanguage
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
            lang: userLanguageSettings.get(session.userId) || pluginConfig.wiki.defaultLanguage
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

  if (pluginConfig.versionCheck.enabled && pluginConfig.versionCheck.groups.length) {
    checkUpdate(minecraftVersions, ctx, pluginConfig)
    setInterval(() => checkUpdate(minecraftVersions, ctx, pluginConfig), pluginConfig.versionCheck.interval * 60 * 1000)
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
}
