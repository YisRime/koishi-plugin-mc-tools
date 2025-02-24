import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import {
  MinecraftToolsConfig,
  MINECRAFT_LANGUAGES,
  LangCode,
  checkServerStatus,
  getMinecraftVersionInfo,
  checkMinecraftUpdate,
  formatErrorMessage,
} from './utils'
import { processMCMODContent, formatContentSections } from './modwiki'
import { processWikiRequest } from './mcwiki'
import { handleModScreenshot, handleWikiScreenshot } from './shot'
import { searchMCMOD, handleSearch } from './search'

export const name = 'mc-tools'
export const inject = {required: ['puppeteer']}


export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    defaultLanguage: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .default('zh')
      .description('默认的 Wiki 浏览语言'),
    pageTimeout: Schema.number()
      .default(30)
      .description('页面超时时间（秒）'),
    searchTimeout: Schema.number()
      .default(10)
      .description('搜索选择超时时间（秒）'),
    searchResultLimit: Schema.number()
      .default(10)
      .description('搜索结果最大显示数量'),
    minSectionLength: Schema.number()
      .default(12)
      .description('段落最小字数'),
    sectionPreviewLength: Schema.number()
      .default(50)
      .description('非首段预览字数'),
    totalPreviewLength: Schema.number()
      .default(500)
      .description('总预览字数限制'),
    searchDescLength: Schema.number()
      .default(60)
      .description('MCMOD搜索结果描述的最大字数'),
    showDescription: Schema.boolean()
      .default(true)
      .description('是否显示搜索结果的描述'),
    imageEnabled: Schema.boolean()
      .default(true)
      .description('是否启用图片显示')
  }).description('Wiki与模组百科相关设置'),

  versionCheck: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('是否启用版本更新检查'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('接收版本更新通知的群组 ID'),
    interval: Schema.number()
      .default(60)
      .description('版本检查间隔时间（分钟）'),
    notifyOnSnapshot: Schema.boolean()
      .default(true)
      .description('快照版本更新时通知'),
    notifyOnRelease: Schema.boolean()
      .default(true)
      .description('正式版本更新时通知')
  }).description('版本更新检查设置'),

  server: Schema.object({
    host: Schema.string()
      .description('默认服务器地址')
      .default('localhost'),
    port: Schema.number()
      .description('默认服务器端口')
      .default(25565),
    showPlayers: Schema.boolean()
      .default(true)
      .description('显示在线玩家'),
    showSettings: Schema.boolean()
      .default(true)
      .description('显示服务器设置'),
    showPing: Schema.boolean()
      .default(true)
      .description('显示延迟信息'),
    showIcon: Schema.boolean()
      .default(true)
      .description('显示服务器图标')
  }).description('默认的 Minecraft 服务器配置')
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, pluginConfig: MinecraftToolsConfig) {
  const userLanguageSettings = new Map<string, LangCode>()
  const minecraftVersions = { snapshot: '', release: '' }

  // Wiki 功能相关代码
  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`mcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图`)

  mcwiki.action(async ({ session }, keyword) => {
    try {
      const result = await processWikiRequest(keyword, session.userId, pluginConfig, ctx, userLanguageSettings)
      return result
    } catch (error) {
      return error.message
    }
  })

  // 修改 modwiki 命令实现
  const modWikiCommand = ctx.command('modwiki <keyword:text>', 'MCMOD搜索(支持模组/整合包/物品/教程)')
    .action(async ({ }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMCMOD(keyword, pluginConfig)
        if (!results.length) return '未找到相关内容'

        const result = results[0]
        const content = await processMCMODContent(result.url, pluginConfig.wiki)
        return formatContentSections(content, result.url)
      } catch (error) {
        return error.message
      }
    })

    mcwiki.subcommand('.search <keyword:text>', '搜索 Wiki 页面（使用 -i 后缀以获取页面截图）')
    .action(async ({ session }, keyword) => {
      return await handleSearch({
        keyword,
        source: 'wiki',
        session,
        config: pluginConfig,
        ctx,
        lang: userLanguageSettings.get(session.userId) || pluginConfig.wiki.defaultLanguage
      })
    })

  // 修改 search 子命令实现
  modWikiCommand.subcommand('.search <keyword:text>', 'MCMOD搜索并返回列表（使用 -i 后缀以获取页面截图）')
    .action(async ({ session }, keyword) => {
      return await handleSearch({
        keyword,
        source: 'mcmod',
        session,
        config: pluginConfig,
        ctx,
        processContent: async (url) => {
          const content = await processMCMODContent(url, pluginConfig.wiki)
          return content.sections.join('\n')
        }
      })
    })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const { handleWikiScreenshot } = require('./shot')
        const wikiResult = await processWikiRequest(keyword, session.userId, pluginConfig, ctx, userLanguageSettings, 'image') as any
        if (typeof wikiResult === 'string') return wikiResult

        await session.send(`正在获取页面...\n完整内容：${wikiResult.url}`)
        const result = await handleWikiScreenshot(keyword, wikiResult.pageUrl,
          userLanguageSettings.get(session.userId) || pluginConfig.wiki.defaultLanguage,
          pluginConfig, ctx)
        return result.image
      } catch (error) {
        return error.message
      }
    })

  modWikiCommand.subcommand('.shot <keyword:text>', '搜索并截图MCMOD条目')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const result = await handleModScreenshot(keyword, pluginConfig, ctx)
        await session.send(`正在获取页面...\n完整内容：${result.url}`)
        return result.image
      } catch (error) {
        return error.message
      }
    })

  ctx.command('mcver', '获取 Minecraft 最新版本')
    .action(async () => {
      const result = await getMinecraftVersionInfo()
      return result.success ? result.data : result.error
    })

  // 版本更新检查
  if (pluginConfig.versionCheck.enabled && pluginConfig.versionCheck.groups.length) {
    checkMinecraftUpdate(minecraftVersions, ctx, pluginConfig)
    setInterval(() => checkMinecraftUpdate(minecraftVersions, ctx, pluginConfig), pluginConfig.versionCheck.interval * 60 * 1000)
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
