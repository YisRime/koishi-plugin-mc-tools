import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MinecraftToolsConfig, LangCode } from './index'
import { buildUrl, fetchContent } from './wiki'
import { fetchModContent, formatContent } from './mod'

// 添加 Element 接口定义在文件顶部
interface Element {
  type: string
  attrs: Record<string, any>
  children?: any[]
}

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
 * @param {MinecraftToolsConfig} config - Minecraft工具配置对象,包含截图相关设置
 * @returns {Promise<{url: string, image: h.Fragment}>} 返回包含截图URL和图片数据的对象
 * @throws {Error} 当截图功能未启用、网络错误或截图失败时抛出错误
 */
export async function capture(
  url: string,
  ctx: any,
  options: { type: 'wiki' | 'mcmod', lang?: LangCode },
  config: MinecraftToolsConfig
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
 * 发送合并转发消息，或在不支持时分段发送
 * @param {any} session - 会话对象
 * @param {string} title - 消息标题
 * @param {string|h.Fragment|(string|Element)[]} content - 消息内容，支持文本、h元素或元素数组
 * @param {string} [url] - 可选的链接URL
 * @returns {Promise<any>} 发送结果或处理状态
 */
export async function sendForwardMessage(session: any, title: string, content: string | h.Fragment | (string | Element)[], url?: string): Promise<any> {
  // 检查是否为Telegram平台或其他不支持合并转发的平台
  const isTelegram = session.platform === 'telegram';
  const supportForward = session?.onebot?._request && !isTelegram;

  // 将内容转换为统一的消息元素数组格式
  let contentElements: any[] = [];

  // 处理不同类型的内容输入
  if (typeof content === 'string') {
    contentElements = [content];
  } else if (Array.isArray(content)) {
    contentElements = content.map(item => {
      if (typeof item === 'string') return item;
      // 处理h元素
      return transformHElement(item);
    });
  } else if (content && typeof content === 'object') {
    // 处理h.Fragment
    contentElements = [transformHElement(content)];
  }

  if (!supportForward) {
    // 当不支持合并转发时，分段发送消息
    try {
      // 添加标题和URL（如果有）
      await session.send(`『${title}』`);

      // 发送内容元素
      for (const element of contentElements) {
        await session.send(element);
      }

      // 发送链接（如果有）
      if (url) {
        await session.send(`详细内容：${url}`);
      }

      return;
    } catch (error) {
      throw new Error(`分段发送消息失败: ${error.message}`);
    }
  }

  // 支持合并转发的平台使用原有逻辑，但支持复杂消息元素
  try {
    const messages = [
      {
        type: 'node',
        data: {
          name: title,
          uin: session.bot.selfId,
          content: contentElements
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
 * 将h元素转换为onebot兼容的消息格式
 * @param {any} element - 要转换的h元素
 * @returns {any} onebot兼容的消息元素
 */
function transformHElement(element: any): any {
  // 如果是字符串，直接返回
  if (typeof element === 'string') {
    return element;
  }

  // 如果是undefined或null，返回空字符串
  if (element == null) {
    return '';
  }

  // 如果是Fragment，处理其children
  if (element.type === 'fragment' && Array.isArray(element.children)) {
    const result = element.children.map(transformHElement).filter(Boolean);
    return result.length ? result : '';
  }

  // 处理图片元素
  if (element.type === 'img' || element.type === 'image') {
    // 处理Buffer或Base64图片数据
    if (element.attrs?.src && (Buffer.isBuffer(element.attrs.src) ||
        (typeof element.attrs.src === 'string' && element.attrs.src.startsWith('data:')))) {
      return {
        type: 'image',
        data: {
          file: element.attrs.src
        }
      };
    }
    // 处理URL图片
    if (element.attrs?.src) {
      return {
        type: 'image',
        data: {
          file: element.attrs.src
        }
      };
    }
  }

  // 处理文本元素
  if (element.type === 'text' && element.attrs?.content) {
    return element.attrs.content;
  }

  // 处理其他常见类型的h元素
  if (element.type === 'at' && element.attrs?.id) {
    return {
      type: 'at',
      data: {
        qq: element.attrs.id
      }
    };
  }

  // 处理一般文本标签
  if (element.children && Array.isArray(element.children)) {
    const processedChildren = element.children.map(transformHElement).filter(Boolean);
    // 如果结果是字符串数组，拼接它们
    if (processedChildren.every(item => typeof item === 'string')) {
      return processedChildren.join('');
    }
    return processedChildren.length ? processedChildren : '';
  }

  // 默认将元素转为字符串
  return String(element);
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
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 * @throws {Error} 搜索失败时抛出错误
 */
export async function searchMod(keyword: string, config: MinecraftToolsConfig): Promise<SearchResult[]> {
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
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @returns {string} 格式化后的搜索结果文本
 */
export function formatSearchResults(
  results: SearchResult[],
  source: 'wiki' | 'mcmod',
  config: MinecraftToolsConfig
): string {
  const items = results.map((r, i) => {
    const base = `${i + 1}. ${r.title}`
    const desc = source === 'mcmod' && config.common.descLength > 0 && r.desc
      ? `\n    ${r.desc}` : ''
    return `${base}${desc}`
  })

  return `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}
输入序号查看详情（添加 -i 获取页面截图）`
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
 * @param {any} [params.session] - 会话对象，用于获取平台信息
 * @returns {Promise<string>} 处理结果或错误信息
 */
export async function processSelection(params: {
  response: string
  results: SearchResult[]
  source: 'wiki' | 'mcmod'
  config: MinecraftToolsConfig
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
 * @param {MinecraftToolsConfig} config - Minecraft工具配置
 * @param {LangCode} [lang] - 语言代码
 * @param {any} [session] - 会话对象，用于获取平台信息
 * @returns {Promise<string>} 页面内容或错误信息
 */
async function fetchwikiContent(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  config: MinecraftToolsConfig,
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
