import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'
import * as mc from 'minecraft-protocol'
import {
  formatErrorMessage,
  getWikiConfiguration,
  getMinecraftVersionFromProtocol,
  MinecraftToolsConfig,
  LANGUAGES,
  LangCode,
  parseServerMessage,
  parseServerPlayerStats,
  parseServerConfiguration,
  checkMinecraftUpdate,
  constructWikiUrl,
} from './utils'
import {
  processModSearchResult,
  processItemSearchResult,
  processPostSearchResult,
  processWikiRequest,
  fetchWikiArticleContent,
  captureWikiPageScreenshot,
} from './wiki'

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
      .description('版本检查间隔时间（分钟）')
  }).description('版本更新检查设置'),

  server: Schema.object({
    host: Schema.string()
      .description('默认服务器地址')
      .default('localhost'),
    port: Schema.number()
      .description('默认服务器端口')
      .default(25565)
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
    .usage(`mcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图\nmcwiki.lang <语言> - 设置显示语言`)

  mcwiki.subcommand('.lang [language:string]', '设置Wiki显示语言')
    .action(({ session }, language) => {
      if (!language) {
        const currentLang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const langList = Object.entries(LANGUAGES)
          .map(([code, name]) => `${code}: ${name}${code === currentLang ? ' (当前)' : ''}`)
          .join('\n')
        return `当前支持的语言：\n${langList}`
      }

      if (!(language in LANGUAGES)) {
        return `不支持的语言代码。支持的语言代码：${Object.keys(LANGUAGES).join(', ')}`
      }

      userLangs.set(session.userId, language as LangCode)
      return `已将 Wiki 显示语言设置为${LANGUAGES[language as LangCode]}`
    })

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

        const { results, domain, lang } = searchResult
        const { variant } = getWikiConfiguration(lang)

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
        const pageUrl = constructWikiUrl(result.title, domain, variant, true)
        const displayUrl = constructWikiUrl(result.title, domain)

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

        const { title, content, url } = await fetchWikiArticleContent(pageUrl, lang, config)
        return `『${title}』${content}\n详细内容：${url}`

      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
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

  // 版本更新检查
  if (config.versionCheck.enabled && config.versionCheck.groups.length) {
    checkMinecraftUpdate(versions, ctx, config)
    setInterval(() => checkMinecraftUpdate(versions, ctx, config), config.versionCheck.interval * 60 * 1000)
  }

  // 服务器状态查询
  ctx.command('mcinfo [server]', '查询 MC 服务器状态')
    .action(async (_, server) => {
      let host = config.server.host
      let port = config.server.port

      if (server) {
        const parts = server.split(':')
        host = parts[0]
        if (parts[1]) {
          const parsedPort = parseInt(parts[1])
          if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            return '端口必须是1-65535之间的数字'
          }
          port = parsedPort
        }
      }

      try {
        const startTime = Date.now()
        const client = await mc.ping({
          host,
          port
        })
        const pingTime = Date.now() - startTime

        const lines: string[] = []

        if (client && 'favicon' in client && client.favicon?.startsWith('data:image/png;base64,')) {
          lines.push(h.image(client.favicon).toString())
        }

        const displayAddr = port === 25565 ? host : `${host}:${port}`
        if (!server) {
          lines.push(displayAddr)
        }

        if ('description' in client && client.description) {
          const motd = parseServerMessage(client.description).trim()
          if (motd) {
            lines.push(motd.replace(/§[0-9a-fk-or]/g, ''))
          }
        }

        let versionInfo = '未知版本'
        if (client?.version) {
          const currentVersion = typeof client.version === 'object'
            ? (client.version.name || '未知版本')
            : String(client.version)

          const protocol = typeof client.version === 'object'
            ? client.version.protocol
            : null

          versionInfo = protocol
            ? `${currentVersion}(${getMinecraftVersionFromProtocol(protocol)})`
            : currentVersion
        }

        const players = 'players' in client ? parseServerPlayerStats(client.players) : { online: 0, max: 0 }
        lines.push(`${versionInfo} | ${players.online}/${players.max} | ${pingTime}ms`)

        const settings = parseServerConfiguration(client)
        if (settings.length) {
          lines.push(settings.join(' | '))
        }

        if (players.sample?.length > 0) {
          const playerList = players.sample
            .filter(p => p && typeof p.name === 'string')
            .map(p => p.name)
          if (playerList.length > 0) {
            let playerInfo = '当前在线：' + playerList.join(', ')
            if (playerList.length < players.online) {
              playerInfo += `（仅显示 ${playerList.length}/${players.online} 名玩家）`
            }
            lines.push(playerInfo)
          }
        }

        return lines.join('\n')
      } catch (error) {
        return `服务器查询失败: ${formatErrorMessage(error)}`
      }
    })

  // 修改 modwiki 命令实现
  const modWikiCommand = ctx.command('modwiki <keyword:text>', 'MCMOD搜索(支持模组/整合包/物品/教程)')
    .action(async ({ }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`
        const searchResponse = await axios.get(searchUrl)
        const searchHtml = searchResponse.data

        // 匹配mod、整合包和物品的链接
        const modMatch = searchHtml.match(/href="(https:\/\/www\.mcmod\.cn\/class\/\d+\.html)"/)
        const modpackMatch = searchHtml.match(/href="(https:\/\/www\.mcmod\.cn\/modpack\/\d+\.html)"/)
        const itemMatch = searchHtml.match(/href="(https:\/\/www\.mcmod\.cn\/item\/\d+\.html)"/)
        const postMatch = searchHtml.match(/href="(https:\/\/www\.mcmod\.cn\/post\/\d+\.html)"/)

        const detailUrl = modMatch?.[1] || modpackMatch?.[1] || itemMatch?.[1] || postMatch?.[1]
        if (!detailUrl) return '未找到相关内容'

        // 根据URL类型选择相应的处理函数
        if (detailUrl.includes('/post/')) {
          return await processPostSearchResult(detailUrl, config.wiki.totalPreviewLength)
        } else if (detailUrl.includes('/item/')) {
          return await processItemSearchResult(detailUrl, config.wiki.totalPreviewLength)
        } else {
          return await processModSearchResult(detailUrl, config.wiki.totalPreviewLength)
        }

      } catch (error) {
        return formatErrorMessage(error)
      }
    })

  // 修改 search 子命令实现
  modWikiCommand.subcommand('.search <keyword:text>', 'MCMOD搜索并返回列表')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`
        const searchResponse = await axios.get(searchUrl)
        const $ = cheerio.load(searchResponse.data)

        const searchResults: { title: string, url: string, desc: string, type: string }[] = []
        $('.result-item').each((_, item) => {
          const $item = $(item)
          const titleEl = $item.find('.head a').last()
          const title = titleEl.text().trim()
          const url = titleEl.attr('href') || ''

          // 根据URL判断类型
          let type = '未知'
          if (url.includes('/modpack/')) {
            type = '整合包'
          } else if (url.includes('/class/')) {
            type = 'MOD'
          } else if (url.includes('/item/')) {
            type = '物品'
          } else if (url.includes('/post/')) {
            type = '教程'
          }

          let desc = config.wiki.searchDescLength > 0 ? $item.find('.body').text().trim()
            .replace(/\[(\w+)[^\]]*\]/g, '')
            .replace(/data:image\/\w+;base64,[a-zA-Z0-9+/=]+/g, '')
            .replace(/\s+/g, ' ')
            .trim() : ''

          if (desc && desc.length > config.wiki.searchDescLength) {
            desc = desc.slice(0, config.wiki.searchDescLength) + '...'
          }

          if (title && url) {
            searchResults.push({
              title,
              url: url.startsWith('http') ? url : `https://www.mcmod.cn${url}`,
              desc: desc || '',
              type
            })
          }
        })

        if (!searchResults.length) return '未找到相关内容'

        const searchResultMessage = searchResults
          .slice(0, config.wiki.searchResultLimit)
          .map((r, i) => `${i + 1}. ${r.title}${r.desc ? `\n    ${r.desc}` : ''}`)
          .join('\n')

        await session.send(`MCMOD 搜索结果：\n${searchResultMessage}\n请回复序号查看详细内容`)
        const response = await session.prompt(config.wiki.searchTimeout * 1000)

        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= searchResults.length) {
          return '请输入有效的序号'
        }

        const selectedResult = searchResults[index]
        // 根据类型选择处理函数
        if (selectedResult.url.includes('/post/')) {
          return await processPostSearchResult(selectedResult.url, config.wiki.totalPreviewLength)
        } else if (selectedResult.url.includes('/item/')) {
          return await processItemSearchResult(selectedResult.url, config.wiki.totalPreviewLength)
        } else {
          return await processModSearchResult(selectedResult.url, config.wiki.totalPreviewLength)
        }

      } catch (error) {
        return formatErrorMessage(error)
      }
    })
}
