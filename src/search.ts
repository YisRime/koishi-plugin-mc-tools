import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MinecraftToolsConfig, LangCode, SearchResult, TypeMap, ModwikiConfig } from './utils'
import { constructWikiUrl, fetchWikiArticleContent } from './mcwiki'
import { captureWikiPageScreenshot } from './shot'
import { processMCMODContent, formatContentSections } from './modwiki'

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
    const searchFunction = source === 'wiki'
      ? (kw: string, cfg: MinecraftToolsConfig) => searchWikiArticles(kw, cfg.wiki.searchResultLimit, cfg.wiki.searchTimeout)
      : searchMCMOD
    const results = await searchFunction(keyword, config)

    if (!results.length) return '未找到相关内容'

    const items = results.map((r, i) => {
      const base = `${i + 1}. ${r.title}`
      const desc = config.wiki.showDescription && r.desc ? `\n    ${r.desc}` : ''
      const type = r.type ? ` [${r.type}]` : ''
      return `${base}${type}${desc}`
    })
    const searchResultMessage = `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}
请回复序号查看详细内容（使用 -i 后缀以获取页面截图）`

    await session.send(searchResultMessage)

    const response = await session.prompt(config.wiki.searchTimeout * 1000)
    if (!response) return '操作超时'

    return await handleUserSelection({ response, results, source, config, ctx, lang, processContent })
  } catch (error) {
    return error.message
  }
}

// Wiki 搜索功能
export async function searchWikiArticles(keyword: string, searchResultLimit: number, pageTimeout: number): Promise<SearchResult[]> {
  try {
    const searchUrl = constructWikiUrl('api.php', 'zh', true).replace('/w/', '/')
      + `&action=opensearch&search=${encodeURIComponent(keyword)}&limit=${searchResultLimit}`;

    const { data } = await axios.get(searchUrl, {
      timeout: pageTimeout * 1000
    });

    const [_, titles, urls] = data;
    if (!titles?.length) return [];
    return titles.map((title, i) => ({ title, url: urls[i], source: 'wiki' }));
  } catch (error) {
    throw new Error(`搜索失败: ${error.message}`);
  }
}

// MCMOD 搜索功能
export async function searchMCMOD(keyword: string, config: MinecraftToolsConfig): Promise<SearchResult[]> {
  try {
    const response = await axios.get(
      `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`,
      { timeout: config.wiki.searchTimeout * 1000 }
    );
    const $ = cheerio.load(response.data);

    const results: SearchResult[] = []
    $('.result-item').each((_, item) => {
      const $item = $(item)
      const titleEl = $item.find('.head a').last()
      const title = titleEl.text().trim()
      const url = titleEl.attr('href') || ''
      const description = $item.find('.desc').text().trim()
      const desc = description
        ? (description.length > config.wiki.searchDescLength
            ? description.slice(0, config.wiki.searchDescLength) + '...'
            : description)
        : ''

      const type = Object.entries(TypeMap.modTypes).find(([key]) => url.includes(key))?.[1] || '未知'
      const normalizedUrl = url.startsWith('http') ? url : `https://www.mcmod.cn${url}`

      if (title && url) {
        results.push({
          title,
          url: normalizedUrl,
          desc,
          type,
          source: 'mcmod'
        })
      }
    })
    return results.slice(0, config.wiki.searchResultLimit)
  } catch (error) {
    throw new Error(`搜索失败: ${error.message}`)
  }
}

// 从 modwiki.ts 移动的函数
export async function processModSearchResult(url: string, config: ModwikiConfig) {
  return formatContentSections(await processMCMODContent(url, config), url)
}

export const processItemSearchResult = processModSearchResult
export const processPostSearchResult = processModSearchResult

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
    const isImageRequest = flag?.trim() === 'i'

    if (isImageRequest) {
      if (!ctx?.puppeteer) return '截图功能不可用'

      const context = await ctx.puppeteer.browser.createBrowserContext()
      const page = await context.newPage()

      try {
        if (source === 'wiki') {
          const pageUrl = constructWikiUrl(result.title, lang, true)
          const { image } = await captureWikiPageScreenshot(page, pageUrl, lang, config)
          return { image: h.image(image, 'image/png') }
        } else {
          const { captureMCMODPageScreenshot } = require('./shot')
          const { image } = await captureMCMODPageScreenshot(page, result.url, config)
          return { image: h.image(image, 'image/jpeg') }
        }
      } finally {
        await context.close()
      }
    }

    if (source === 'wiki') {
      const pageUrl = constructWikiUrl(result.title, lang, true)
      const displayUrl = constructWikiUrl(result.title, lang)
      const { title, content } = await fetchWikiArticleContent(pageUrl, lang, config)
      return `『${title}』${content}\n详细内容：${displayUrl}`
    }

    if (processContent) {
      try {
        const content = await processContent(result.url)
        return content || `获取内容失败，请直接访问：${result.url}`
      } catch (error) {
        return `获取内容失败 (${error.message})，请直接访问：${result.url}`
      }
    }

    return `请直接访问：${result.url}`
  } catch (error) {
    return `处理内容时出错，请直接访问：${results[parseInt(response) - 1]?.url || '链接获取失败'}`
  }
}
