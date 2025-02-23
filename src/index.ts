import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

import {
  MinecraftToolsConfig,
  LANGUAGES,
  LangCode,
  checkServerStatus,
  getMinecraftVersionInfo,
  checkMinecraftUpdate,
  formatErrorMessage,
} from './utils'
import {
  processModSearchResult,
  processItemSearchResult,
  processPostSearchResult,
  searchMCMOD,
  processMCMODContent
} from './modwiki'
import {
  constructWikiUrl,
  processWikiRequest,
  fetchWikiArticleContent,
  captureWikiPageScreenshot
} from './mcwiki'

export const name = 'mc-tools'
export const inject = {required: ['puppeteer']}


export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    defaultLanguage: Schema.union(Object.keys(LANGUAGES) as LangCode[])
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
export function apply(ctx: Context, config: MinecraftToolsConfig) {
  const userLangs = new Map<string, LangCode>()
  const versions = { snapshot: '', release: '' }

  // Wiki 功能相关代码
  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`mcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图`)

  mcwiki.action(async ({ session }, keyword) => {
    try {
      const result = await processWikiRequest(keyword, session.userId, config, ctx, userLangs)
      return result
    } catch (error) {
      return error.message
    }
  })

  mcwiki.subcommand('.search <keyword:text>', '搜索 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        const searchResult = await processWikiRequest(keyword, session.userId, config, ctx, userLangs, 'search') as any
        if (typeof searchResult === 'string') return searchResult

        const { results, lang } = searchResult

        const searchResultMessage = `Wiki 搜索结果：\n${
          results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
        }\n请回复序号查看对应内容\n（使用 -i 后缀以获取页面截图）`

        await session.send(searchResultMessage)
        const response = await session.prompt(config.wiki.searchTimeout * 1000)

        if (!response) return '操作超时'

        const [input, flag] = response.split('-')
        const index = parseInt(input) - 1

        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        const result = results[index]
        const pageUrl = constructWikiUrl(result.title, lang, true)
        const displayUrl = constructWikiUrl(result.title, lang)

        if (flag?.trim() === 'i') {
          await session.send(`正在获取页面...\n完整内容：${displayUrl}`)
          const context = await ctx.puppeteer.browser.createBrowserContext()
          const page = await context.newPage()
          try {
            const { image } = await captureWikiPageScreenshot(page, pageUrl, lang, config)
            return h.image(image, 'image/png')
          } finally {
            await context.close()
          }
        }

        const { title, content } = await fetchWikiArticleContent(pageUrl, lang, config)
        return `『${title}』${content}\n详细内容：${displayUrl}`

      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
      if (!config.wiki.imageEnabled) {
        return '图片功能已禁用'
      }
      try {
        const result = await processWikiRequest(keyword, session.userId, config, ctx, userLangs, 'image') as any
        if (typeof result === 'string') return result

        // 先发送URL
        await session.send(`正在获取页面...\n完整内容：${result.url}`)

        // 然后获取并发送图片
        const { image } = await result.getImage()
        return h.image(image, 'image/png')
      } catch (error) {
        return error.message
      }
    })

  // 修改 modwiki 命令实现
  const modWikiCommand = ctx.command('modwiki <keyword:text>', 'MCMOD搜索(支持模组/整合包/物品/教程)')
    .action(async ({ }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMCMOD(keyword, config.wiki)
        if (!results.length) return '未找到相关内容'

        const result = results[0]
        const contentProcessor = result.url.includes('/post/') ? processPostSearchResult :
                               result.url.includes('/item/') ? processItemSearchResult :
                               processModSearchResult

        return await contentProcessor(result.url, config.wiki)
      } catch (error) {
        return error.message
      }
    })

  // 修改 search 子命令实现
  modWikiCommand.subcommand('.search <keyword:text>', 'MCMOD搜索并返回列表')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMCMOD(keyword, config.wiki)
        if (!results.length) return '未找到相关内容'

        const searchResultMessage = results
          .slice(0, config.wiki.searchResultLimit)
          .map((r, i) => `${i + 1}. ${r.title}${r.desc ? `\n    ${r.desc}` : ''}`)
          .join('\n')

        await session.send(`MCMOD 搜索结果：\n${searchResultMessage}\n请回复序号查看详细内容`)
        const response = await session.prompt(config.wiki.searchTimeout * 1000)

        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        return await processMCMODContent(results[index].url, config.wiki)

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
  if (config.versionCheck.enabled && config.versionCheck.groups.length) {
    checkMinecraftUpdate(versions, ctx, config)
    setInterval(() => checkMinecraftUpdate(versions, ctx, config), config.versionCheck.interval * 60 * 1000)
  }

  ctx.command('mcinfo [server]', '查询 MC 服务器状态')
    .usage('mcinfo [地址[:端口]] - 查询服务器状态')
    .example('mcinfo mc.example.com:25566 - 查询指定端口的服务器')
    .action(async ({ }, server) => {
      try {
        return await checkServerStatus(server, config)
      } catch (error) {
        return formatErrorMessage(error)
      }
    })
}
