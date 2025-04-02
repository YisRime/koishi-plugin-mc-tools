import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MTConfig, LangCode } from './index'
import { buildUrl, fetchContent } from './wiki'
import { fetchModContent, formatContent } from './mod'

export interface SearchResult {
  title: string
  url: string
  desc?: string
  source: 'wiki' | 'mcmod'
}
const CLEANUP_SELECTORS = [
  // Wiki 相关
  '.mw-editsection', '#mw-navigation', '#footer', '.noprint', '#toc',
  '.navbox', '#siteNotice', '#contentSub', '.mw-indicators',
  '.sister-wiki', '.external', 'script', 'meta', '#mw-head',
  '#mw-head-base', '#mw-page-base', '#catlinks', '.printfooter',
  '.mw-jump-link', '.vector-toc', '.vector-menu',
  '.mw-cite-backlink', '.reference', '.treeview',
  '.file-display-header',
  // MCMOD 相关
  'header', 'footer', '.header-container', '.common-background',
  '.common-nav', '.common-menu-page', '.common-comment-block',
  '.comment-ad', '.ad-leftside', '.slidetips', '.item-table-tips',
  '.common-icon-text-frame', '.common-ad-frame', '.ad-class-page',
  '.class-rating-submit', '.common-icon-text.edit-history',
  // MCMOD 论坛相关
  '.ad', '.under', '#scrolltop', '.po', '#f_pst', '.psth', '.sign', '.sd',
  '#append_parent', '.wrap-posts.total', '.rate', '.ratl','.cm', '.modact',
]

/**
 * 捕获网页页面截图
 * @param {string} url - 需要截图的目标页面URL
 * @param {any} ctx - Koishi上下文对象,需包含puppeteer实例
 * @param {Object} options - 截图配置选项
 * @param {('wiki'|'mcmod')} options.type - 页面类型,支持wiki或mcmod
 * @param {LangCode} [options.lang] - 可选的语言代码,仅wiki类型需要
 * @param {MTConfig} config - Minecraft工具配置对象,包含截图相关设置
 * @returns {Promise<{url: string, image: h.Fragment}>} 返回包含截图URL和图片数据的对象
 * @throws {Error} 当截图功能未启用、网络错误或截图失败时抛出错误
 */
export async function capture(
  url: string,
  ctx: any,
  options: { type: 'wiki' | 'mcmod', lang?: LangCode },
  config: MTConfig
) {
  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()

  try {
    await Promise.all([
      page.setRequestInterception(true),
      page.setCacheEnabled(true),
      page.setJavaScriptEnabled(false)
    ])

    // 设置统一的浏览器头信息
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    })

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
          waitUntil: config.common.waitUntil,
          timeout: config.common.captureTimeout * 1000
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

    const clipData = await page.evaluate((data) => {
      const { type, url, maxHeight } = data
      let selector

      if (type === 'wiki') {
        selector = '#content'
      } else {
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
        height: maxHeight === 0 ? Math.ceil(rect.height) : Math.min(maxHeight, Math.ceil(rect.height))
      }
    }, { type: options.type, url, maxHeight: config.common.maxHeight })

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
 * 发送合并转发消息
 * @param {any} session - 会话对象
 * @param {string} title - 消息标题
 * @param {string} content - 消息内容
 * @param {string} [url] - 可选的链接URL
 * @returns {Promise<any>} 发送结果或原始内容字符串（当不支持合并转发时）
 */
export async function sendForwardMessage(session: any, title: string, content: string, url?: string): Promise<any> {
  if (!session?.onebot?._request) {
    // 当不支持合并转发时，返回原始内容供直接发送
    return `${title}\n${content}${url ? `\n详细内容: ${url}` : ''}`;
  }

  try {
    // 准备转发消息节点 - 将title和content合并到一个节点
    const combinedContent = `${title}\n${content}${url ? `\n详细内容: ${url}` : ''}`;
    const messages = [
      {
        type: 'node',
        data: {
          name: 'Minecraft 工具',
          uin: session.bot.selfId,
          content: combinedContent
        }
      }
    ];

    // 发送合并转发消息
    const messageType = session.subtype === 'group' ? 'group' : 'private';
    const params: any = {
      message_type: messageType,
      messages
    };

    if (messageType === 'group') {
      params.group_id = session.guildId;
    } else {
      params.user_id = session.userId;
    }

    const result = await session.onebot._request('send_forward_msg', params);
    return {
      messageId: result.message_id,
      resId: result.res_id
    };
  } catch (error) {
    throw new Error(`发送合并转发消息失败: ${error.message}`);
  }
}

/**
 * 统一的搜索处理
 * @param {Object} params - 搜索参数
 * @param {string} params.keyword - 搜索关键词
 * @param {('wiki'|'mcmod')} params.source - 搜索源
 * @param {any} params.session - 会话对象
 * @param {MTConfig} params.config - Minecraft工具配置
 * @param {any} [params.ctx] - Koishi上下文对象
 * @param {LangCode} [params.lang] - 语言代码
 * @returns {Promise<string>} 搜索结果或错误信息
 */
export async function search(params: {
  keyword: string
  source: 'wiki' | 'mcmod'
  session: any
  config: MTConfig
  ctx?: any
  lang?: LangCode
}) {
  const { keyword, source, session, config, ctx, lang } = params

  if (!keyword) return '请输入搜索关键词'

  try {
    const searchFn = source === 'wiki' ? searchWiki : searchMod
    const results = await searchFn(keyword, config)

    if (!results.length) return '没有找到相关内容'

    const message = formatSearchResults(results, source, config)
    await session.send(message)

    const response = await session.prompt(config.common.Timeout * 1000)
    if (!response) return '等待超时，已取消操作'

    return await processSelection({ response, results, source, config, ctx, lang, session })
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
export async function searchWiki(keyword: string, _config?: any): Promise<SearchResult[]> {
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
    throw new Error(`搜索出错：${error.message}`);
  }
}

/**
 * MCMOD 搜索
 * @param {string} keyword - 搜索关键词
 * @param {MTConfig} config - Minecraft工具配置
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 * @throws {Error} 搜索失败时抛出错误
 */
export async function searchMod(keyword: string, config: MTConfig): Promise<SearchResult[]> {
  try {
    const response = await axios.get(
      `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`,
      {         timeout: config.common.Timeout * 1000       }
    );
    const $ = cheerio.load(response.data);

    const results: SearchResult[] = []
    $('.result-item').each((_, item) => {
      const $item = $(item)
      const titleEl = $item.find('.head a').last()
      const title = titleEl.text().trim()
      const url = titleEl.attr('href') || ''
      const desc = config.common.descLength > 0
        ? $item.find('.body').text().trim().replace(/\[.*?\]/g, '').trim()
        : ''
      const normalizedDesc = desc && desc.length > config.common.descLength
        ? desc.slice(0, config.common.descLength) + '...'
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
 * @param {MTConfig} config - Minecraft工具配置
 * @returns {string} 格式化后的搜索结果文本
 */
export function formatSearchResults(
  results: SearchResult[],
  source: 'wiki' | 'mcmod',
  config: MTConfig
): string {
  const items = results.map((r, i) => {
    const base = `${i + 1}. ${r.title}`
    const desc = source === 'mcmod' && config.common.descLength > 0 && r.desc
      ? `\n    ${r.desc}` : ''
    return `${base}${desc}`
  })

  return `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}输入序号查看详情（添加 -i 获取页面截图）`
}

/**
 * 处理用户选择
 * @param {Object} params - 处理参数
 * @param {string} params.response - 用户响应
 * @param {SearchResult[]} params.results - 搜索结果列表
 * @param {('wiki'|'mcmod')} params.source - 搜索源
 * @param {MTConfig} params.config - Minecraft工具配置
 * @param {any} [params.ctx] - Koishi上下文对象
 * @param {LangCode} [params.lang] - 语言代码
 * @param {any} [params.session] - 会话对象，用于获取平台信息
 * @returns {Promise<string>} 处理结果或错误信息
 */
export async function processSelection(params: {
  response: string
  results: SearchResult[]
  source: 'wiki' | 'mcmod'
  config: MTConfig
  ctx?: any
  lang?: LangCode
  session?: any
}) {
  const { response, results, source, config, ctx, lang, session } = params

  const [input, flag] = response.split('-')
  const index = parseInt(input) - 1

  if (isNaN(index) || index < 0 || index >= results.length) {
    return '请输入正确的序号'
  }

  const result = results[index]
  const isImage = flag?.trim() === 'i'

  try {
    return isImage
      ? await fetchImage(result, source, ctx, config, lang)
      : await fetchwikiContent(result, source, config, lang, session)
  } catch (error) {
    return `处理内容时出错 (${error?.message || String(error)})，请直接访问：${result.url}`
  }
}

/**
 * 获取页面截图
 * @param {SearchResult} result - 搜索结果项
 * @param {('wiki'|'mcmod')} source - 内容源
 * @param {any} ctx - Koishi上下文对象
 * @param {MTConfig} config - Minecraft工具配置
 * @param {LangCode} [lang] - 语言代码
 * @returns {Promise<string>} 截图结果或错误信息
 */
async function fetchImage(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  ctx: any,
  config: MTConfig,
  lang?: LangCode
) {
  if (!ctx?.puppeteer) return '截图功能未启用'

  try {
    if (source === 'wiki') {
      const pageUrl = buildUrl(result.title, lang, true)
      const { image } = await capture(pageUrl, ctx, { type: 'wiki', lang }, config)
      return image
    } else {
      const { image } = await capture(result.url, ctx, { type: 'mcmod' }, config)
      return image
    }
  } catch (error) {
    return `截图失败: ${error.message}`
  }
}

/**
 * 获取页面内容
 * @param {SearchResult} result - 搜索结果项
 * @param {('wiki'|'mcmod')} source - 内容源
 * @param {MTConfig} config - Minecraft工具配置
 * @param {LangCode} [lang] - 语言代码
 * @param {any} [session] - 会话对象，用于获取平台信息
 * @returns {Promise<string>} 页面内容或错误信息
 */
async function fetchwikiContent(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  config: MTConfig,
  lang?: LangCode,
  session?: any
) {
  // 当启用合并转发时尝试使用合并转发
  const useForwardMsg = config.common.useForwardMsg;

  if (source === 'wiki') {
    const pageUrl = buildUrl(result.title, lang, true)
    const displayUrl = buildUrl(result.title, lang)

    if (useForwardMsg) {
      try {
        // 获取完整内容，忽略长度限制
        const tempConfig = JSON.parse(JSON.stringify(config));
        tempConfig.common.totalLength = 10000;
        tempConfig.specific.sectionLength = 5000;

        const { title, content } = await fetchContent(pageUrl, lang, tempConfig);
        const response = await sendForwardMessage(session, `『${title}』`, content, displayUrl);

        // 如果返回的是字符串，说明平台不支持合并转发，直接返回内容
        if (typeof response === 'string') {
          return response;
        }
        return '';
      } catch (error) {
        return `合并转发消息发送失败: ${error.message}\n『${result.title}』的内容请访问: ${displayUrl}`;
      }
    }

    const { title, content } = await fetchContent(pageUrl, lang, config)
    return `『${title}』${content}\n详细内容：${displayUrl}`
  }

  if (useForwardMsg) {
    try {
      // 获取完整内容，忽略长度限制
      const tempConfig = JSON.parse(JSON.stringify(config.common));
      tempConfig.totalLength = 10000;

      const content = await fetchModContent(result.url, tempConfig);
      const formattedContent = formatContent(content, result.url, {
        linkCount: 999, // 显示所有链接
        showImages: config.specific.showImages,
        platform: session.platform
      });

      const title = content.sections?.[0] || result.title;
      const response = await sendForwardMessage(session, title, formattedContent, result.url);

      // 如果返回的是字符串，说明平台不支持合并转发，直接返回内容
      if (typeof response === 'string') {
        return response;
      }
      return '';
    } catch (error) {
      return `合并转发消息发送失败: ${error.message}\n内容请访问: ${result.url}`;
    }
  }

  const content = await fetchModContent(result.url, config.common)
  return formatContent(content, result.url, {
    linkCount: config.specific.linkCount,
    showImages: config.specific.showImages,
    platform: session.platform
  }) || `内容获取失败，请访问：${result.url}`
}
