import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MinecraftToolsConfig, LangCode, SearchResult, CLEANUP_SELECTORS } from './utils'
import { buildUrl, fetchContent } from './mcwiki'
import { fetchModContent, formatContent } from './modwiki'

/**
 * 捕获页面截图
 * @param {string} url - 要截图的页面URL
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @param {any} ctx - Koishi上下文对象
 * @param {Object} options - 截图选项
 * @param {('wiki'|'mcmod')} options.type - 页面类型
 * @param {LangCode} [options.lang] - 语言代码
 * @returns {Promise<{url: string, image: h.Fragment}>} 返回截图结果
 * @throws {Error} 当截图功能禁用或截图失败时抛出错误
 */
export async function capture(
  url: string,
  config: MinecraftToolsConfig,
  ctx: any,
  options: { type: 'wiki' | 'mcmod', lang?: LangCode }
) {
  if (!config.wiki.imageEnabled) {
    throw new Error('图片功能已禁用')
  }

  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()

  try {
    await Promise.all([
      page.setRequestInterception(true),
      page.setCacheEnabled(true),
      page.setJavaScriptEnabled(false)
    ])

    page.on('request', request => {
      const resourceType = request.resourceType()
      const url = request.url().toLowerCase()

      // 允许的资源类型
      const allowedTypes = ['stylesheet', 'image', 'fetch', 'xhr', 'document']
      const allowedKeywords = ['.svg', 'canvas', 'swiper', '.css', '.png', '.jpg', '.jpeg']
      const shouldAllow =
        allowedTypes.includes(resourceType) ||
        allowedKeywords.some(keyword => url.includes(keyword)) ||
        url.includes('static') || url.includes('assets')

      if (!shouldAllow && ['media', 'font', 'manifest', 'script'].includes(resourceType)) {
        request.abort()
      } else {
        request.continue()
      }
    })

    if (options.type === 'wiki' && options.lang) {
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${options.lang},${options.lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${options.lang}; hl=${options.lang}; uselang=${options.lang}`
      })
    }

    let retries = 2
    while (retries > 0) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 5000
        })
        break
      } catch (err) {
        retries--
        if (retries === 0) throw err
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }

    if (options.type === 'wiki') {
      await page.evaluate(() => {
        const content = document.querySelector('#mw-content-text .mw-parser-output')
        const newBody = document.createElement('div')
        newBody.id = 'content'
        if (content) {
          newBody.appendChild(content.cloneNode(true))
        }
        document.body.innerHTML = ''
        document.body.appendChild(newBody)
      })
    }

    await page.evaluate((selectors) => {
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
    }, CLEANUP_SELECTORS)

    // 获取截图区域
    const clipData = await page.evaluate((data) => {
      const { type, url } = data
      let selector

      if (type === 'wiki') {
        selector = '#content'
      } else {
        // 判断页面类型
        if (url.includes('bbs.mcmod.cn')) {
          selector = '#postlist'
        } else if (url.includes('/item/')) {
          selector = '.col-lg-12.right'
        } else {
          selector = '.col-lg-12.center'
        }
      }

      const element = document.querySelector(selector)
      if (!element) return null

      const rect = element.getBoundingClientRect()
      return {
        x: 0,
        y: Math.max(0, Math.floor(rect.top)),
        width: 1080,
        height: Math.min(4096, Math.ceil(rect.height))
      }
    }, { type: options.type, url })

    await page.setViewport({
      width: clipData.width,
      height: clipData.height,
      deviceScaleFactor: 1,
      isMobile: false
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 75,
      clip: clipData,
      omitBackground: true,
      optimizeForSpeed: true
    })

    return {
      url,
      image: h.image(screenshot, 'image/jpeg')
    }

  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
  } finally {
    await context.close()
  }
}

/**
 * 统一的搜索处理
 * @param {Object} params - 搜索参数
 * @param {string} params.keyword - 搜索关键词
 * @param {('wiki'|'mcmod')} params.source - 搜索源
 * @param {any} params.session - 会话对象
 * @param {MinecraftToolsConfig} params.config - Minecraft工具配置
 * @param {any} [params.ctx] - Koishi上下文对象
 * @param {LangCode} [params.lang] - 语言代码
 * @returns {Promise<string>} 搜索结果或错误信息
 */
export async function search(params: {
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
    const searchFn = source === 'wiki' ? searchWiki : searchMod
    const results = await searchFn(keyword, config)

    if (!results.length) return '未找到相关内容'

    const message = formatSearchResults(results, source, config)
    await session.send(message)

    const response = await session.prompt(config.wiki.searchTimeout * 1000)
    if (!response) return '操作超时'

    return await processSelection({ response, results, source, config, ctx, lang })
  } catch (error) {
    return error.message
  }
}

/**
 * Wiki 搜索
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 * @throws {Error} 搜索失败时抛出错误
 */
export async function searchWiki(keyword: string): Promise<SearchResult[]> {
  try {
    const searchUrl = buildUrl('api.php', 'zh', true).replace('/w/', '/')
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
 * MCMOD 搜索
 * @param {string} keyword - 搜索关键词
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 * @throws {Error} 搜索失败时抛出错误
 */
export async function searchMod(keyword: string, config: MinecraftToolsConfig): Promise<SearchResult[]> {
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
 * 格式化搜索结果
 * @param {SearchResult[]} results - 搜索结果列表
 * @param {('wiki'|'mcmod')} source - 搜索源
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @returns {string} 格式化后的搜索结果文本
 */
function formatSearchResults(
  results: SearchResult[],
  source: 'wiki' | 'mcmod',
  config: MinecraftToolsConfig
): string {
  const items = results.map((r, i) => {
    const base = `${i + 1}. ${r.title}`
    const desc = source === 'mcmod' && config.wiki.searchDescLength > 0 && r.desc
      ? `\n    ${r.desc}` : ''
    return `${base}${desc}`
  })

  return `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}
请回复序号查看详细内容（使用 -i 后缀以获取页面截图）`
}

/**
 * 处理用户选择
 * @param {Object} params - 处理参数
 * @param {string} params.response - 用户响应
 * @param {SearchResult[]} params.results - 搜索结果列表
 * @param {('wiki'|'mcmod')} params.source - 搜索源
 * @param {MinecraftToolsConfig} params.config - Minecraft工具配置
 * @param {any} [params.ctx] - Koishi上下文对象
 * @param {LangCode} [params.lang] - 语言代码
 * @returns {Promise<string>} 处理结果或错误信息
 */
async function processSelection(params: {
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
  const isImage = flag?.trim() === 'i'

  try {
    return isImage
      ? await fetchImage(result, source, ctx, config, lang)
      : await fetchwikiContent(result, source, config, lang)
  } catch (error) {
    return `处理内容时出错 (${error?.message || String(error)})，请直接访问：${result.url}`
  }
}

/**
 * 获取页面截图
 * @param {SearchResult} result - 搜索结果项
 * @param {('wiki'|'mcmod')} source - 内容源
 * @param {any} ctx - Koishi上下文对象
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @param {LangCode} [lang] - 语言代码
 * @returns {Promise<string>} 截图结果或错误信息
 */
async function fetchImage(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  ctx: any,
  config: MinecraftToolsConfig,
  lang?: LangCode
) {
  if (!ctx?.puppeteer) return '截图功能不可用'

  const context = await ctx.puppeteer.browser.createBrowserContext()
  try {
    const { handleWikiScreenshot, handleModScreenshot } = require('./shot')

    if (source === 'wiki') {
      const pageUrl = buildUrl(result.title, lang, true)
      return await handleWikiScreenshot('', pageUrl, lang, config, ctx)
    } else {
      return await handleModScreenshot(result.title, config, ctx)
    }
  } finally {
    await context.close()
  }
}

/**
 * 获取页面内容
 * @param {SearchResult} result - 搜索结果项
 * @param {('wiki'|'mcmod')} source - 内容源
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @param {LangCode} [lang] - 语言代码
 * @returns {Promise<string>} 页面内容或错误信息
 */
async function fetchwikiContent(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  config: MinecraftToolsConfig,
  lang?: LangCode
) {
  if (source === 'wiki') {
    const pageUrl = buildUrl(result.title, lang, true)
    const displayUrl = buildUrl(result.title, lang)
    const { title, content } = await fetchContent(pageUrl, lang, config)
    return `『${title}』${content}\n详细内容：${displayUrl}`
  }

  const content = await fetchModContent(result.url, config.wiki)
  return formatContent(content, result.url) || `获取内容失败，请直接访问：${result.url}`
}
