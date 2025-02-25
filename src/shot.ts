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
    // 设置公共请求头和重试机制
    if (options.type === 'wiki' && options.lang) {
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${options.lang},${options.lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${options.lang}; hl=${options.lang}; uselang=${options.lang}`,
        'Cache-Control': 'no-cache'
      })
    }

    // 重试加载页面
    let retries = 3
    while (retries > 0) {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: 10000
        })
        break
      } catch (err) {
        retries--
        if (retries === 0) throw err
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    // 根据类型处理页面
    if (options.type === 'wiki') {
      await page.waitForSelector('#bodyContent', { timeout: 10000, visible: true })

      // 处理Wiki页面内容
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
    } else {
      await page.waitForSelector('.maintext, .col-lg-12.center', { timeout: 10000, visible: true })
    }

    // 统一使用清理选择器
    await page.evaluate((selectors) => {
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
    }, CLEANUP_SELECTORS)

    // 注入通用样式
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        body {
          margin: 0 !important;
          padding: 0 !important;
          background: white !important;
          font-family: system-ui, -apple-system, sans-serif;
        }
        #content {
          margin: 0 auto;
          padding: 20px;
          box-sizing: border-box;
          width: 100%;
        }
        .mw-parser-output {
          max-width: 960px;
          margin: 0 auto;
          line-height: 1.6;
        }
        img { max-width: 100%; height: auto; }
        table {
          margin: 1em auto;
          border-collapse: collapse;
          max-width: 100%;
        }
        td, th { padding: 0.5em; border: 1px solid #ccc; }
        pre {
          padding: 1em;
          background: #f5f5f5;
          border-radius: 4px;
          overflow-x: auto;
        }
      `
      document.head.appendChild(style)
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
      deviceScaleFactor: 1
    })

    await new Promise(resolve => setTimeout(resolve, 500))

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      clip: clipData,
      omitBackground: true
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
