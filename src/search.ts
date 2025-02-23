import axios from 'axios'
import * as cheerio from 'cheerio'
import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'
import {
  constructWikiUrl,
  processWikiRequest,
  fetchWikiArticleContent,
} from './mcwiki'
import { captureWikiPageScreenshot } from './shot'

export interface SearchResult {
  title: string
  url: string
  desc?: string
  type?: string
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
    return titles.map((title, i) => ({ title, url: urls[i] }))
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
        type
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

// MCMOD 搜索处理函数
export async function handleMCMODSearch(
  keyword: string,
  config: MinecraftToolsConfig,
  session: any,
  processContent: (url: string) => Promise<string>
): Promise<string> {
  if (!keyword) return '请输入要查询的关键词'

  try {
    const results = await searchMCMOD(keyword, config)
    if (!results.length) return '未找到相关内容'

    const searchResultMessage = results
      .slice(0, config.wiki.searchResultLimit)
      .map((r, i) => `${i + 1}. ${r.title}${
        config.wiki.showDescription && r.desc ? `\n    ${r.desc}` : ''
      }`)
      .join('\n')

    await session.send(`MCMOD 搜索结果：\n${searchResultMessage}\n请回复序号查看详细内容`)
    const response = await session.prompt(config.wiki.searchTimeout * 1000)

    if (!response) return '操作超时'

    const index = parseInt(response) - 1
    if (isNaN(index) || index >= results.length) {
      return '请输入有效的序号'
    }

    return await processContent(results[index].url)
  } catch (error) {
    return error.message
  }
}

// Wiki搜索处理函数

export async function handleWikiSearch(
  keyword: string,
  session: any,
  config: MinecraftToolsConfig,
  ctx: any,
  userLangs: Map<string, LangCode>,
  lang: LangCode
): Promise<string | { image: any }> {
  try {
    const searchResult = await processWikiRequest(keyword, session.userId, config, ctx, userLangs, 'search')
    if (typeof searchResult === 'string') return searchResult

    const { results } = searchResult

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
        return { image: h.image(image, 'image/png') }
      } finally {
        await context.close()
      }
    }

    const { title, content } = await fetchWikiArticleContent(pageUrl, lang, config)
    return `『${title}』${content}\n详细内容：${displayUrl}`
  } catch (error) {
    return error.message
  }
}
