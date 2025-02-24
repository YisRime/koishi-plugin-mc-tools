import axios from 'axios'
import * as cheerio from 'cheerio'
import { MinecraftToolsConfig, LangCode, SearchResult } from './utils'
import { constructWikiUrl, fetchWikiArticleContent } from './mcwiki'
import { processMCMODContent, formatContentSections } from './modwiki'

/**
 * 统一的搜索处理函数
 * @param {Object} params - 搜索参数
 * @param {string} params.keyword - 搜索关键词
 * @param {'wiki' | 'mcmod'} params.source - 搜索源
 * @param {any} params.session - Koishi 会话实例
 * @param {MinecraftToolsConfig} params.config - 插件配置
 * @param {any} [params.ctx] - Koishi 上下文(可选)
 * @param {LangCode} [params.lang] - 语言代码(可选)
 * @returns {Promise<string>} 搜索结果或错误信息
 */
export async function handleSearch(params: {
  keyword: string
  source: 'wiki' | 'mcmod'
  session: any
  config: MinecraftToolsConfig
  ctx?: any
  lang?: LangCode
}) {
  const { keyword, source, session, config, ctx, lang } = params

  if (!keyword) return '请输入要查询的关键词'

  try {
    const searchFunction = source === 'wiki'
      ? (kw: string, cfg: MinecraftToolsConfig) => searchWikiArticles(kw)
      : searchMCMOD
    const results = await searchFunction(keyword, config)

    if (!results.length) return '未找到相关内容'

    const items = results.map((r, i) => {
      const base = `${i + 1}. ${r.title}`
      const desc = source === 'mcmod' && config.wiki.searchDescLength > 0 && r.desc
        ? `\n    ${r.desc}` : ''
      return `${base}${desc}`
    })
    const searchResultMessage = `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}
请回复序号查看详细内容（使用 -i 后缀以获取页面截图）`

    await session.send(searchResultMessage)

    const response = await session.prompt(config.wiki.searchTimeout * 1000)
    if (!response) return '操作超时'

    return await handleUserSelection({ response, results, source, config, ctx, lang })
  } catch (error) {
    return error.message
  }
}

/**
 * Wiki 搜索功能
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 */
export async function searchWikiArticles(keyword: string): Promise<SearchResult[]> {
  try {
    const searchUrl = constructWikiUrl('api.php', 'zh', true).replace('/w/', '/')
      + `&action=opensearch&search=${encodeURIComponent(keyword)}&limit=10`;

    const { data } = await axios.get(searchUrl, {
      timeout: 30000
    });

    const [_, titles, urls] = data;
    if (!titles?.length) return [];
    return titles.map((title, i) => ({ title, url: urls[i], source: 'wiki' }));
  } catch (error) {
    throw new Error(`搜索失败: ${error.message}`);
  }
}

/**
 * MCMOD 搜索功能
 * @param {string} keyword - 搜索关键词
 * @param {MinecraftToolsConfig} config - 插件配置
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 */
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
      const desc = config.wiki.searchDescLength > 0
        ? $item.find('.body').text().trim().replace(/\[.*?\]/g, '').trim()
        : ''
      const normalizedDesc = desc && desc.length > config.wiki.searchDescLength
        ? desc.slice(0, config.wiki.searchDescLength) + '...'
        : desc

      const normalizedUrl = url.startsWith('http') ? url : `https://www.mcmod.cn${url}`

      if (title && url) {
        results.push({
          title,
          url: normalizedUrl,
          desc: normalizedDesc,
          source: 'mcmod'
        })
      }
    })
    return results.slice(0, 10)
  } catch (error) {
    throw new Error(`搜索失败: ${error.message}`)
  }
}

/**
 * 处理用户搜索结果选择
 * @param {Object} params - 参数对象
 * @returns {Promise<string | any>} 处理结果
 */
async function handleUserSelection(params: {
  response: string
  results: SearchResult[]
  source: 'wiki' | 'mcmod'
  config: MinecraftToolsConfig
  ctx?: any
  lang?: LangCode
}) {
  const { response, results, source, config, ctx, lang } = params

  const [input, flag] = response.split('-')
  const index = parseInt(input) - 1

  if (isNaN(index) || index < 0 || index >= results.length) {
    return '请输入有效的序号'
  }

  const result = results[index]
  const isImageRequest = flag?.trim() === 'i'

  try {
    if (isImageRequest) {
      return await handleImageRequest(result, source, ctx, config, lang)
    }
    return await handleContentRequest(result, source, config, lang)
  } catch (error) {
    const errorMessage = error?.message || String(error)
    return `处理内容时出错 (${errorMessage})，请直接访问：${result.url}`
  }
}

/**
 * 处理图片请求
 * @param {SearchResult} result - 搜索结果
 * @param {'wiki' | 'mcmod'} source - 来源
 * @param {any} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {LangCode} [lang] - 语言代码
 * @returns {Promise<any>} 图片处理结果
 */
async function handleImageRequest(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  ctx: any,
  config: MinecraftToolsConfig,
  lang?: LangCode
) {
  if (!ctx?.puppeteer) {
    return '截图功能不可用'
  }

  const context = await ctx.puppeteer.browser.createBrowserContext()

  try {
    if (source === 'wiki') {
      const pageUrl = constructWikiUrl(result.title, lang, true)
      const { handleWikiScreenshot } = require('./shot')
      const res = await handleWikiScreenshot('', pageUrl, lang, config, ctx)
      return res
    } else {
      const { handleModScreenshot } = require('./shot')
      const res = await handleModScreenshot(result.title, config, ctx)
      return res
    }
  } finally {
    await context.close()
  }
}

/**
 * 处理内容请求
 * @param {SearchResult} result - 搜索结果
 * @param {'wiki' | 'mcmod'} source - 来源
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {LangCode} [lang] - 语言代码
 * @returns {Promise<string>} 格式化的内容
 */
async function handleContentRequest(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  config: MinecraftToolsConfig,
  lang?: LangCode
) {
  if (source === 'wiki') {
    const pageUrl = constructWikiUrl(result.title, lang, true)
    const displayUrl = constructWikiUrl(result.title, lang)
    const { title, content } = await fetchWikiArticleContent(pageUrl, lang, config)
    return `『${title}』${content}\n详细内容：${displayUrl}`
  }

  const content = await processMCMODContent(result.url, config.wiki)
  const formattedContent = formatContentSections(content, result.url)
  return formattedContent || `获取内容失败，请直接访问：${result.url}`
}
