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
  fetchWikiArticleContent,
  captureWikiPageScreenshot,
  checkMinecraftUpdate,
  processWikiRequest,
  constructWikiUrl,
} from './utils'

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
        const response = await session.prompt(10000)

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

  // 通用的格式化详情函数
  const formatModItemDetails = ($: cheerio.CheerioAPI, isModpack = false) => {
    const contentSections: string[] = []

    // 提取标题信息
    const shortName = $('.short-name').first().text().trim()
    const title = $('.class-title h3').first().text().trim()
    const enTitle = $('.class-title h4').first().text().trim()

    // 获取状态文本（仅适用于mod）
    const modStatusLabels: string[] = []
    if (!isModpack) {
      $('.class-official-group .class-status').each((_, elem) => {
        modStatusLabels.push($(elem).text().trim())
      })
      $('.class-official-group .class-source').each((_, elem) => {
        modStatusLabels.push($(elem).text().trim())
      })
    }

    // 组合标题
    const formattedTitle = `${shortName} ${enTitle} | ${title}${!isModpack && modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''}`
    contentSections.push(formattedTitle)

    // 提取封面图片
    const coverImage = $('.class-cover-image img').first()
    if (coverImage.length) {
      const imgSrc = coverImage.attr('src')
      if (imgSrc) {
        const fullImgSrc = imgSrc.startsWith('http') ? imgSrc : `https:${imgSrc}`
        contentSections.push(h.image(fullImgSrc).toString())
      }
    }

    // 提取信息
    $('.class-info-left .col-lg-4').each((_, elem) => {
      const text = $(elem).text().trim()
        .replace(/\s+/g, ' ')
        .replace(/：/g, ': ')

      if (isModpack) {
        // 整合包只保留特定信息
        if (text.includes('整合包类型') ||
            text.includes('运作方式') ||
            text.includes('打包方式')) {
          contentSections.push(text)
        }
      } else {
        // mod只保留运行环境信息
        if (text.includes('运行环境')) {
          contentSections.push(text)
        }
      }
    })

    return contentSections
  }

  // 通用的版本信息格式化函数
  const formatModVersionInfo = ($: cheerio.CheerioAPI, isModpack = false) => {
    const contentSections: string[] = []

    if (isModpack) {
      // 整合包版本信息处理
      const versionInfo: string[] = []
      $('.mcver ul li').each((_, elem) => {
        const text = $(elem).text().trim()
        if (text && !text.includes('Forge:') && text.match(/^\d/)) {
          versionInfo.push(text)
        }
      })

      if (versionInfo.length) {
        contentSections.push('支持版本:')
        contentSections.push(versionInfo.join(', '))
      }
    } else {
      // MOD版本信息处理
      const versionInfo: Record<string, string[]> = {}
      $('.mcver ul').each((_, elem) => {
        const loaderText = $(elem).find('li:first').text().trim()
        const versions: string[] = []

        $(elem).find('a').each((_, verElem) => {
          const version = $(verElem).text().trim()
          if (version.match(/^\d/)) {
            versions.push(version)
          }
        })

        if (versions.length > 0) {
          const loader = loaderText.split(':')[0].trim()
          versionInfo[loader] = versions
        }
      })

      const versionTexts = Object.entries(versionInfo)
        .filter(([_, vers]) => vers.length > 0)
        .map(([loader, vers]) => `${loader}: ${vers.join('\n')}`)

      if (versionTexts.length) {
        contentSections.push('支持版本:')
        contentSections.push(versionTexts.join('\n'))
      }
    }

    return contentSections
  }

  // 修改 formatModContent 函数
  const formatModDescription = ($: cheerio.CheerioAPI, totalPreviewLength: number, type: 'mod' | 'modpack' | 'item' = 'mod') => {
    const contentSections: string[] = []

    if (type === 'item') {
      // 处理物品名称和图标
      const itemName = $('.itemname .name h5').text().trim()
      if (itemName) contentSections.push(itemName)

      const itemIcon = $('.item-info-table img').first()
      if (itemIcon.length) {
        const imgSrc = itemIcon.attr('src')
        if (imgSrc) {
          const fullImgSrc = imgSrc.startsWith('http') ? imgSrc : `https:${imgSrc}`
          contentSections.push(h.image(fullImgSrc).toString())
        }
      }

      // 添加合成表处理
      $('.TableBlock').each((_, elem) => {
        const $table = $(elem)
        const bgImage = $table.css('background-image')
        if (bgImage) {
          // 获取合成表的项目
          const items: {x: number, y: number, img: string}[] = []
          $table.find('.item-table-hover').each((_, item) => {
            const $item = $(item)
            const style = $item.attr('style') || ''
            const marginMatch = style.match(/margin:(\d+)px\s+0\s+0\s+(\d+)px/)
            if (marginMatch) {
              const img = $item.find('img').first()
              const imgSrc = img.attr('src')
              if (imgSrc) {
                items.push({
                  x: parseInt(marginMatch[2]),
                  y: parseInt(marginMatch[1]),
                  img: imgSrc.startsWith('http') ? imgSrc : `https:${imgSrc}`
                })
              }
            }
          })

          if (items.length > 0) {
            // TODO: 这里可以添加合成表整体截图的逻辑
            contentSections.push('合成配方:')
            for (const item of items) {
              contentSections.push(h.image(item.img).toString())
            }
          }
        }
      })

      contentSections.push('\n物品介绍:')
    } else {
      // 处理 mod/整合包详情
      contentSections.push(
        ...formatModItemDetails($, type === 'modpack'),
        ...formatModVersionInfo($, type === 'modpack')
      )
    }

    // 处理内容区域
    const contentArea = type === 'item' ? $('.item-content.common-text') : $('.common-text')

    if (contentArea.length) {
      if (type !== 'item') {
        contentSections.push(`\n${type === 'modpack' ? '整合包' : '模组'}介绍:`)
      }

      let totalLength = 0
      let skipNext = false

      contentArea.children().each((_, elem) => {
        const $elem = $(elem)

        // 统一应用字数限制
        if (totalLength >= totalPreviewLength) return false

        if (skipNext) {
          skipNext = false
          return
        }

        // 处理图片
        const figure = $elem.find('.figure')
        if (figure.length) {
          const img = figure.find('img')
          if (img.length) {
            let imgSrc = img.attr('data-src') || img.attr('src')
            if (imgSrc && !imgSrc.startsWith('http')) {
              imgSrc = `https:${imgSrc}`
            }
            if (imgSrc) {
              contentSections.push(h.image(imgSrc).toString())
            }
          }
          return
        }

        if ($elem.is('p, ol, ul')) {
          const title = $elem.find('span.common-text-title')
          if (title.length) {
            const nextP = $elem.next('p')
            if (nextP.length) {
              const nextText = nextP.clone()
                .find('script,.figure').remove().end()
                .text()
                .trim()
                .replace(/\s+/g, ' ')
                .replace(/\[(\w+)\]/g, '')

              if (nextText) {
                let combinedText = `『${title.text().trim()}』${nextText}`
                const remainingChars = totalPreviewLength - totalLength
                if (combinedText.length > remainingChars) {
                  combinedText = combinedText.slice(0, remainingChars) + '......'
                  totalLength = totalPreviewLength
                } else {
                  totalLength += combinedText.length
                }
                contentSections.push(combinedText)
                skipNext = true
              } else {
                contentSections.push(`『${title.text().trim()}』`)
              }
              return
            } else {
              contentSections.push(`『${title.text().trim()}』`)
              return
            }
          }

          let text = $elem.clone()
            .find('script,.figure').remove().end()
            .text()
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\[(\w+)\]/g, '')

          if (text) {
            const remainingChars = totalPreviewLength - totalLength
            if (text.length > remainingChars) {
              text = text.slice(0, remainingChars) + '......'
              totalLength = totalPreviewLength
            } else {
              totalLength += text.length
            }
            contentSections.push(text)
          }
        }
      })
    }

    return contentSections
  }

  // 修改搜索结果处理函数
  const processModSearchResult = async (url: string) => {
    const response = await axios.get(url)
    const $ = cheerio.load(response.data)
    const contentSections: string[] = []
    const isModpack = url.includes('/modpack/')

    contentSections.push(
      ...formatModItemDetails($, isModpack),
      ...formatModVersionInfo($, isModpack),
      ...formatModDescription($, config.wiki.totalPreviewLength, isModpack ? 'modpack' : 'mod')
    )

    contentSections.push(`\n详细内容: ${url}`)

    return contentSections
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // 修改 processItemSearchResult 函数以使用新的 formatModDescription
  const processItemSearchResult = async (url: string) => {
    const response = await axios.get(url)
    const $ = cheerio.load(response.data)
    const contentSections = formatModDescription($, config.wiki.totalPreviewLength, 'item')

    contentSections.push(`\n详细内容: ${url}`)

    return contentSections
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // 修改 modwiki 命令实现
  const modWikiCommand = ctx.command('modwiki <keyword:text>', 'MCMOD搜索(支持模组/整合包/物品)')
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

        const detailUrl = modMatch?.[1] || modpackMatch?.[1] || itemMatch?.[1]
        if (!detailUrl) return '未找到相关内容'

        // 根据URL类型选择相应的处理函数
        if (detailUrl.includes('/item/')) {
          return await processItemSearchResult(detailUrl)
        } else {
          return await processModSearchResult(detailUrl)
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
          .map((r, i) => `${i + 1}. [${r.type}] ${r.title}${r.desc ? `\n  ${r.desc}` : ''}`)
          .join('\n')

        await session.send(`MCMOD 搜索结果：\n${searchResultMessage}\n请回复序号查看详细内容`)
        const response = await session.prompt(10000)

        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= searchResults.length) {
          return '请输入有效的序号'
        }

        const selectedResult = searchResults[index]
        // 根据类型选择处理函数
        if (selectedResult.url.includes('/item/')) {
          return await processItemSearchResult(selectedResult.url)
        } else {
          return await processModSearchResult(selectedResult.url)
        }

      } catch (error) {
        return formatErrorMessage(error)
      }
    })
}
