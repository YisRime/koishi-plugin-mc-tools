import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'
import * as mc from 'minecraft-protocol'
import {
  handleError,
  getWikiDomain,
  buildWikiUrl,
  getVersionFromProtocol,
  MinecraftToolsConfig,
  LANGUAGES,
  LangCode,
  extractServerText,
  formatServerPlayers,
  getServerSettings,
  getWikiContent,
  captureWiki,
  checkVersion,
  handleWikiPage
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
      const result = await handleWikiPage(keyword, session.userId, config, ctx, userLangs)
      return result
    } catch (error) {
      return error.message
    }
  })

  mcwiki.subcommand('.search <keyword:text>', '搜索 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        const searchResult = await handleWikiPage(keyword, session.userId, config, ctx, userLangs, 'search') as any
        if (typeof searchResult === 'string') return searchResult

        const { results, domain, lang } = searchResult
        const { variant } = getWikiDomain(lang)

        const msg = `Wiki 搜索结果：\n${
          results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
        }\n请回复序号查看对应内容\n（使用 -i 后缀以获取页面截图）`

        await session.send(msg)
        const response = await session.prompt(10000)

        if (!response) return '操作超时'

        const [input, flag] = response.split('-')
        const index = parseInt(input) - 1

        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        const result = results[index]
        const pageUrl = buildWikiUrl(result.title, domain, variant, true)
        const displayUrl = buildWikiUrl(result.title, domain)

        if (flag?.trim() === 'i') {
          await session.send(`正在获取页面...\n完整内容：${displayUrl}`)
          const context = await ctx.puppeteer.browser.createBrowserContext()
          const page = await context.newPage()
          try {
            const { image } = await captureWiki(page, pageUrl, lang, config)
            return h.image(image, 'image/png')
          } finally {
            await context.close()
          }
        }

        const { title, content, url } = await getWikiContent(pageUrl, lang, config)
        return `『${title}』${content}\n详细内容：${url}`

      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
      try {
        const result = await handleWikiPage(keyword, session.userId, config, ctx, userLangs, 'image') as any
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

  // 版本更新检查 - 删除原有的 checkVersion 函数，直接使用导入的函数
  if (config.versionCheck.enabled && config.versionCheck.groups.length) {
    checkVersion(versions, ctx, config)
    setInterval(() => checkVersion(versions, ctx, config), config.versionCheck.interval * 60 * 1000)
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
          const motd = extractServerText(client.description).trim()
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
            ? `${currentVersion}(${getVersionFromProtocol(protocol)})`
            : currentVersion
        }

        const players = 'players' in client ? formatServerPlayers(client.players) : { online: 0, max: 0 }
        lines.push(`${versionInfo} | ${players.online}/${players.max} | ${pingTime}ms`)

        const settings = getServerSettings(client)
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
        return `服务器查询失败: ${handleError(error)}`
      }
    })

  // 抽取格式化mod信息的函数
  const formatModDetails = ($: cheerio.CheerioAPI) => {
    const sections: string[] = []

    // 提取mod标题信息和状态
    const shortName = $('.short-name').first().text().trim()
    const title = $('.class-title h3').first().text().trim()
    const enTitle = $('.class-title h4').first().text().trim()
    const statusTexts: string[] = []
    $('.class-official-group .class-status').each((_, elem) => {
      statusTexts.push($(elem).text().trim())
    })
    $('.class-official-group .class-source').each((_, elem) => {
      statusTexts.push($(elem).text().trim())
    })

    // 组合新的标题格式
    const formattedTitle = `${shortName} ${enTitle} | ${title}${statusTexts.length ? ` (${statusTexts.join(' | ')})` : ''}`
    sections.push(formattedTitle)

    // 提取并添加封面图片
    const coverImage = $('.class-cover-image img').first()
    if (coverImage.length) {
      const imgSrc = coverImage.attr('src')
      if (imgSrc) {
        sections.push(h.image(imgSrc).toString())
      }
    }

    // 提取运行环境信息
    const envInfo = $('.class-info-left .col-lg-4').map((_, elem) => {
      const text = $(elem).text().trim()
        .replace(/\s+/g, ' ')
        .replace(/：/g, ': ')
      if (text && text.includes('运行环境')) {
        return text
      }
    }).get().filter(Boolean)

    if (envInfo.length) {
      sections.push(envInfo.join('\n'))
    }

    return sections
  }

  // 抽取版本信息格式化函数
  const formatVersionInfo = ($: cheerio.CheerioAPI) => {
    const sections: string[] = []
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

    // 按加载器组织版本信息
    const versionTexts = Object.entries(versionInfo)
      .filter(([_, vers]) => vers.length > 0)
      .map(([loader, vers]) => `${loader}: ${vers.join(', ')}`)

    if (versionTexts.length) {
      sections.push('支持版本:')
      sections.push(versionTexts.join('\n'))
    }

    return sections
  }

  // 修改 formatModContent 函数
  const formatModContent = ($: cheerio.CheerioAPI, totalPreviewLength: number, isModpack = false) => {
    const sections: string[] = []
    const contentArea = $('.common-text')

    if (contentArea.length) {
      // 根据类型显示不同的标题
      sections.push(`\n${isModpack ? '整合包' : '模组'}介绍:`)
      let totalLength = 0
      let skipNext = false

      contentArea.children().each((_, elem) => {
        // 跳过 class-info-left 中的时间和编辑次数信息
        const $elem = $(elem)
        if ($elem.find('.class-info-left').length) {
          return
        }

        if (totalLength >= totalPreviewLength) return false

        if (skipNext) {
          skipNext = false
          return
        }

        if ($elem.is('p')) {
          const title = $elem.find('span.common-text-title')
          if (title.length) {
            const nextP = $elem.next('p')
            if (nextP.length) {
              const nextText = nextP.clone()
                .find('script,img,.figure').remove().end()
                .text()
                .trim()
                .replace(/\s+/g, ' ')
                .replace(/\[(\w+)\]/g, '')

              if (nextText) {
                sections.push(`『${title.text().trim()}』${nextText}`)
                skipNext = true
              } else {
                sections.push(`『${title.text().trim()}』`)
              }
              return
            } else {
              sections.push(`『${title.text().trim()}』`)
              return
            }
          }

          let text = $elem.clone()
            .find('script,img,.figure').remove().end()
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
            sections.push(text)
          }
        }
      })
    }

    return sections
  }

  // 添加整合包详情格式化函数
  const formatModpackDetails = ($: cheerio.CheerioAPI) => {
    const sections: string[] = []

    // 提取整合包标题信息
    const shortName = $('.short-name').first().text().trim()
    const title = $('.class-title h3').first().text().trim()
    const enTitle = $('.class-title h4').first().text().trim()

    // 组合新的标题格式统一为 shortName enTitle | title
    const formattedTitle = `${shortName} ${enTitle} | ${title}`
    sections.push(formattedTitle)

    // 提取封面图片
    const coverImage = $('.class-cover-image img').first()
    if (coverImage.length) {
      const imgSrc = coverImage.attr('src')
      if (imgSrc) {
        sections.push(h.image(imgSrc).toString())
      }
    }

    // 只提取指定的基本信息
    $('.class-info-left .col-lg-4').each((_, elem) => {
      const text = $(elem).text().trim()
        .replace(/\s+/g, ' ')
        .replace(/：/g, ': ')

      // 只保留整合包类型、运作方式、打包方式这三类信息
      if (text.includes('整合包类型') ||
          text.includes('运作方式') ||
          text.includes('打包方式')) {
        sections.push(text)
      }
    })

    return sections
  }

  // 添加整合包版本信息格式化函数
  const formatModpackVersionInfo = ($: cheerio.CheerioAPI) => {
    const sections: string[] = []
    const versionInfo: string[] = []

    $('.mcver ul li').each((_, elem) => {
      const text = $(elem).text().trim()
      if (text && !text.includes('Forge:') && text.match(/^\d/)) {
        versionInfo.push(text)
      }
    })

    if (versionInfo.length) {
      sections.push('支持版本:')
      sections.push(versionInfo.join(', '))
    }

    return sections
  }

  // 修改搜索结果处理函数
  const processSearchResult = async (url: string) => {
    const response = await axios.get(url)
    const $ = cheerio.load(response.data)
    const sections: string[] = []
    const isModpack = url.includes('/modpack/')

    if (isModpack) {
      sections.push(
        ...formatModpackDetails($),
        ...formatModpackVersionInfo($),
        ...formatModContent($, config.wiki.totalPreviewLength, true)
      )
    } else {
      sections.push(
        ...formatModDetails($),
        ...formatVersionInfo($),
        ...formatModContent($, config.wiki.totalPreviewLength, false)
      )
    }

    sections.push(`\n详细内容: ${url}`)

    return sections
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // 修改 modwiki 命令实现
  const modwikiCmd = ctx.command('modwiki <keyword:text>', 'MCMOD直接搜索')
    .action(async ({ }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`
        const searchResponse = await axios.get(searchUrl)
        const searchHtml = searchResponse.data

        // 同时匹配mod和整合包的链接
        const modMatch = searchHtml.match(/href="(https:\/\/www\.mcmod\.cn\/class\/\d+\.html)"/)
        const modpackMatch = searchHtml.match(/href="(https:\/\/www\.mcmod\.cn\/modpack\/\d+\.html)"/)

        const detailUrl = modMatch?.[1] || modpackMatch?.[1]
        if (!detailUrl) return '未找到相关内容'

        return await processSearchResult(detailUrl)

      } catch (error) {
        return handleError(error)
      }
  })

  // 修改 search 子命令实现
  modwikiCmd.subcommand('.search <keyword:text>', 'MCMOD搜索并返回列表')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`
        const searchResponse = await axios.get(searchUrl)
        const $ = cheerio.load(searchResponse.data)

        const results: { title: string, url: string, desc: string, type: string }[] = []
        $('.result-item').each((_, item) => {
          const $item = $(item)
          const titleEl = $item.find('.head a').last()
          const title = titleEl.text().trim()
          const url = titleEl.attr('href') || ''
          const type = url.includes('/modpack/') ? '整合包' : 'MOD'

          let desc = $item.find('.body').text().trim()
            .replace(/\[(\w+)[^\]]*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim()

          if (desc.length > config.wiki.searchDescLength) {
            desc = desc.slice(0, config.wiki.searchDescLength) + '...'
          }

          if (title && url) {
            results.push({
              title,
              url: url.startsWith('http') ? url : `https://www.mcmod.cn${url}`,
              desc: desc || '暂无简介',
              type
            })
          }
        })

        if (!results.length) return '未找到相关内容'

        const msg = results
          .slice(0, config.wiki.searchResultLimit)
          .map((r, i) => `${i + 1}. [${r.type}] ${r.title}\n  ${r.desc}`)
          .join('\n')

        await session.send(`MCMOD 搜索结果：\n${msg}\n请回复序号查看详细内容`)
        const response = await session.prompt(10000)

        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        const target = results[index]
        return await processSearchResult(target.url)

      } catch (error) {
        return handleError(error)
      }
    })
}
