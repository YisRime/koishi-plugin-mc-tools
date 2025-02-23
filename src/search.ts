import axios from 'axios'
import * as cheerio from 'cheerio'
import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'
import { constructWikiUrl, fetchWikiArticleContent } from './mcwiki'
import { captureWikiPageScreenshot } from './shot'

export interface SearchResult {
  title: string
  url: string
  desc?: string
  type?: string
  source: 'wiki' | 'mcmod'
}

// 统一的搜索处理函数
export async function handleSearch(params: {
  keyword: string
  source: 'wiki' | 'mcmod'
  session: any
  config: MinecraftToolsConfig
  ctx?: any
  lang?: LangCode
  processContent?: (url: string) => Promise<string>
}) {
  const { keyword, source, session, config, ctx, lang, processContent } = params

  if (!keyword) return '请输入要查询的关键词'

  try {
    // 执行搜索
    const results = await (source === 'wiki'
      ? searchWikiArticles(keyword, config.wiki.searchResultLimit, config.wiki.pageTimeout)
      : searchMCMOD(keyword, config))

    if (!results.length) return '未找到相关内容'

    // 构建搜索结果消息
    const searchResultMessage = formatSearchResults(results, config)
    await session.send(searchResultMessage)

    // 等待用户选择
    const response = await session.prompt(config.wiki.searchTimeout * 1000)
    if (!response) return '操作超时'

    return await handleUserSelection({
      response,
      results,
      source,
      config,
      ctx,
      lang,
      processContent
    })

  } catch (error) {
    return error.message
  }
}

// Wiki 搜索功能
export async function searchWikiArticles(keyword: string, searchResultLimit: number, pageTimeout: number): Promise<SearchResult[]> {
  try {
    const searchUrl = constructWikiUrl('api.php', 'zh', true).replace('/w/', '/')
      + `&action=opensearch&search=${encodeURIComponent(keyword)}&limit=${searchResultLimit}`
    const { data } = await axios.get(searchUrl, {
      timeout: pageTimeout * 1000
    })

    const [_, titles, urls] = data
    if (!titles?.length) return []
    return titles.map((title, i) => ({ title, url: urls[i], source: 'wiki' }))
  } catch (error) {
    throw new Error('搜索失败，请稍后重试')
  }
}

// MCMOD 搜索功能
export async function searchMCMOD(keyword: string, config: MinecraftToolsConfig): Promise<SearchResult[]> {
  try {
    const response = await axios.get(
      `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`,
      { timeout: config.wiki.searchTimeout * 1000 }
    )
    const $ = cheerio.load(response.data)
    return parseSearchResults($, config)
  } catch (error) {
    throw new Error(`搜索失败: ${error.message}`)
  }
}

// MCMOD 搜索结果解析
function parseSearchResults($: cheerio.CheerioAPI, config: MinecraftToolsConfig): SearchResult[] {
  const results: SearchResult[] = []
  $('.result-item').each((_, item) => {
    const $item = $(item)
    const titleEl = $item.find('.head a').last()
    const title = titleEl.text().trim()
    const url = titleEl.attr('href') || ''
    const desc = processSearchDescription($item, config.wiki.searchDescLength)
    const type = getContentType(url)

    if (title && url) {
      results.push({
        title,
        url: normalizeUrl(url),
        desc,
        type,
        source: 'mcmod'
      })
    }
  })
  return results.slice(0, config.wiki.searchResultLimit)
}

function processSearchDescription($item: cheerio.Cheerio<any>, searchDescLength: number): string {
  const description = $item.find('.desc').text().trim()
  if (!description) return ''

  return description.length > searchDescLength
    ? description.slice(0, searchDescLength) + '...'
    : description
}

function getContentType(url: string): string {
  const types = {
    '/modpack/': '整合包',
    '/class/': 'MOD',
    '/item/': '物品',
    '/post/': '教程'
  }
  return Object.entries(types).find(([key]) => url.includes(key))?.[1] || '未知'
}

function normalizeUrl(url: string): string {
  return url.startsWith('http') ? url : `https://www.mcmod.cn${url}`
}

function formatSearchResults(results: SearchResult[], config: MinecraftToolsConfig): string {
  const items = results.map((r, i) => {
    const base = `${i + 1}. ${r.title}`
    const desc = config.wiki.showDescription && r.desc ? `\n    ${r.desc}` : ''
    return base + desc
  })

  return `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}
请回复序号查看详细内容${results[0].source === 'wiki' ? '\n（使用 -i 后缀以获取页面截图）' : ''}`
}

async function handleUserSelection(params: {
  response: string
  results: SearchResult[]
  source: 'wiki' | 'mcmod'
  config: MinecraftToolsConfig
  ctx?: any
  lang?: LangCode
  processContent?: (url: string) => Promise<string>
}) {
  const { response, results, source, config, ctx, lang, processContent } = params

  try {
    const [input, flag] = response.split('-')
    const index = parseInt(input) - 1

    if (isNaN(index) || index < 0 || index >= results.length) {
      return '请输入有效的序号'
    }

    const result = results[index]

    if (source === 'wiki') {
      return await handleWikiSelection(result, flag, config, ctx, lang)
    } else if (processContent) {
      try {
        const content = await processContent(result.url)
        if (!content) {
          throw new Error('内容处理失败')
        }
        return content
      } catch (error) {
        console.error('处理MCMOD内容时出错:', error)
        return `获取内容失败 (${error.message})，请直接访问：${result.url}`
      }
    }

    return `无法处理内容，请直接访问：${result.url}`
  } catch (error) {
    console.error('处理选择时出错:', error)
    const fallbackUrl = results[parseInt(response) - 1]?.url || '链接获取失败'
    return `处理内容时出错 (${error.message})，请直接访问：${fallbackUrl}`
  }
}

async function handleWikiSelection(
  result: SearchResult,
  flag: string,
  config: MinecraftToolsConfig,
  ctx: any,
  lang: LangCode
) {
  const pageUrl = constructWikiUrl(result.title, lang, true)
  const displayUrl = constructWikiUrl(result.title, lang)

  if (flag?.trim() === 'i') {
    const context = await ctx.puppeteer.browser.createBrowserContext()
    const page = await context.newPage()
    try {
      const { image } = await captureWikiPageScreenshot(page, pageUrl, lang, config)
      return { image: h.image(image, 'image/png') }
    } finally {
      await context.close()
    }
  }

  const { title, content } = await fetchWikiArticleContent(pageUrl, lang, config)
  return `『${title}』${content}\n详细内容：${displayUrl}`
}
