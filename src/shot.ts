import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'

// 通用清理选择器
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
  '.common-icon-text-frame', '.common-ad-frame', '.ad-class-page'
]

export async function capturePageScreenshot(
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
      page.setJavaScriptEnabled(false),
      page.setRequestInterception(true),
      page.setCacheEnabled(true),
    ])

    // 更严格的资源拦截
    page.on('request', request => {
      const resourceType = request.resourceType()
      if (['media', 'font', 'script', 'manifest'].includes(resourceType)) {
        request.abort()
      } else {
        request.continue()
      }
    })

    // 设置公共请求头和重试机制
    if (options.type === 'wiki' && options.lang) {
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${options.lang},${options.lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${options.lang}; hl=${options.lang}; uselang=${options.lang}`,
        'Cache-Control': 'no-cache'
      })
    }

    // 超时策略
    let retries = 1
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
      }
    }

    // 页面处理优化
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

    // 统一使用清理选择器
    await page.evaluate((selectors) => {
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
    }, CLEANUP_SELECTORS)

    // 精简的样式注入
    await page.evaluate(() => {
      document.head.innerHTML = '<style>body{margin:0;padding:0;background:#fff}#content{margin:0 auto;padding:20px;width:100%}img{max-width:100%}</style>'
    })

    // 获取截图区域
    const clipData = await page.evaluate((data) => {
      const { type, url } = data
      let selector

      if (type === 'wiki') {
        selector = '#content'
      } else {
        if (url.includes('/item/')) {
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

    if (!clipData) {
      throw new Error('无法获取页面内容区域')
    }

    await page.setViewport({
      width: clipData.width,
      height: clipData.height,
      deviceScaleFactor: 1,
      isMobile: false
    })

    await new Promise(resolve => setTimeout(resolve, 100))

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
