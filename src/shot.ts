import { h } from 'koishi'
import { MTConfig } from './index'

// 清理选择器列表
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
 * @param {string} url - 要捕获的URL
 * @param {any} ctx - Koishi 上下文
 * @param {Object} options - 捕获选项
 * @param {MTConfig} config - 插件配置
 * @returns {Promise<{url: string, image: any}>} 截图结果
 */
export async function capture(
  url: string,
  ctx: any,
  options: { type: 'wiki' | 'mcmod', lang?: string },
  config: MTConfig
) {
  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()
  try {
    // 初始化页面设置
    await Promise.all([
      page.setRequestInterception(true),
      page.setCacheEnabled(true),
      page.setJavaScriptEnabled(false),
      page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      })
    ])
    // 配置请求拦截
    page.on('request', request => {
      const resourceType = request.resourceType()
      const url = request.url().toLowerCase()
      const allowedTypes = ['stylesheet', 'image', 'fetch', 'xhr', 'document']
      const allowedKeywords = ['.svg', 'canvas', 'swiper', '.css', '.png', '.jpg', '.jpeg', 'static', 'assets']
      const shouldAllow = allowedTypes.includes(resourceType) ||
                          allowedKeywords.some(keyword => url.includes(keyword))
      if (!shouldAllow && ['media', 'font', 'manifest', 'script'].includes(resourceType)) {
        request.abort()
      } else {
        request.continue()
      }
    })
    // 为 wiki 页面设置语言头
    if (options.type === 'wiki' && options.lang) {
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${options.lang},${options.lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${options.lang}; hl=${options.lang}; uselang=${options.lang}`
      })
    }
    // 页面加载，带重试逻辑
    for (let i = 0; i < 2; i++) {
      try {
        await page.goto(url, {
          waitUntil: config.waitUntil,
          timeout: config.captureTimeout < 0 ? 0 : config.captureTimeout * 1000
        })
        break
      } catch (err) {
        if (i === 1) throw err
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    // 处理Wiki页面DOM
    if (options.type === 'wiki') {
      await page.evaluate(() => {
        const content = document.querySelector('#mw-content-text .mw-parser-output')
        const newBody = document.createElement('div')
        newBody.id = 'content'
        if (content) newBody.appendChild(content.cloneNode(true))
        document.body.innerHTML = ''
        document.body.appendChild(newBody)
      })
    }
    // 清理无关元素
    await page.evaluate((selectors) => {
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
    }, CLEANUP_SELECTORS)
    // 确定截图区域
    const clipData = await page.evaluate((data) => {
      const { type, url, maxHeight } = data
      // 根据页面类型确定选择器
      const selector = type === 'wiki' ? '#content' :
                      url.includes('bbs.mcmod.cn') ? '#postlist' :
                      url.includes('/item/') ? '.col-lg-12.right' : '.col-lg-12.center'
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: 0,
        y: Math.max(0, Math.floor(rect.top)),
        width: 1080,
        height: maxHeight <= 0 ? Math.ceil(rect.height) : Math.min(maxHeight, Math.ceil(rect.height))
      }
    }, { type: options.type, url, maxHeight: config.maxHeight })
    // 设置视口并截图
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
