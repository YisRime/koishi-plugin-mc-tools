import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'
import { searchMCMOD } from './search'

// 通用清理选择器
const CLEANUP_SELECTORS = {
  wiki: [
    '.mw-editsection',
    '#mw-navigation',
    '#footer',
    '.noprint',
    '#toc',
    '.navbox',
    '#siteNotice',
    '#contentSub',
    '.mw-indicators',
    '.sister-wiki',
    '.external',
    'script',
    'meta',
    '#mw-head',
    '#mw-head-base',
    '#mw-page-base',
    '#catlinks',
    '.printfooter',
    '.mw-jump-link',
    '.vector-toc',
    '.vector-menu',
    '.mw-cite-backlink',
    '.reference',
    '.treeview',
    '.file-display-header'
  ],
  mcmod: [
    'header',
    'footer',
    '.header-container',
    '.common-background',
    '.common-nav',
    '.common-menu-page',
    '.common-comment-block',
    '.comment-ad',
    '.ad-leftside',
    '.slidetips',
    '.item-table-tips',
    '.common-icon-text-frame',
    'script',
    '.common-ad-frame',
    '.ad-class-page',
    '.item-data'
  ]
}

interface ScreenshotOptions {
  url: string
  page: any
  config: MinecraftToolsConfig
  type: 'wiki' | 'mcmod'
  lang?: LangCode
}

// 统一的截图处理函数
async function capturePageScreenshot({ url, page, config, type, lang }: ScreenshotOptions) {
  try {
    // 基础视图设置
    await page.setViewport({
      width: 1080,
      height: type === 'wiki' ? 1920 : 800,
      deviceScaleFactor: 1
    })

    // Wiki 特定头部设置
    if (type === 'wiki' && lang) {
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`,
        'Cache-Control': 'no-cache'
      })
    }

    // 加载页面
    let retries = 3
    while (retries > 0) {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: config.wiki.pageTimeout * 1000
        })
        break
      } catch (err) {
        retries--
        if (retries === 0) throw err
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    // 等待内容加载
    const mainSelector = type === 'wiki' ? '#bodyContent' :
                        url.includes('/item/') ? '.maintext' : '.col-lg-12.center'
    await page.waitForSelector(mainSelector, {
      timeout: config.wiki.pageTimeout * 1000,
      visible: true
    })

    // 注入样式和处理内容
    await page.evaluate((params) => {
      const { type, selectors } = params

      // 清理无用元素
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })

      // 注入样式
      const style = document.createElement('style')
      style.textContent = type === 'wiki' ? `
        body { margin: 0; background: white; font-family: system-ui, -apple-system, sans-serif; }
        #content { margin: 0 auto; padding: 20px; box-sizing: border-box; width: 100%; }
        .mw-parser-output { max-width: 960px; margin: 0 auto; line-height: 1.6; }
        img { max-width: 100%; height: auto; }
        table { margin: 1em auto; border-collapse: collapse; max-width: 100%; }
        td, th { padding: 0.5em; border: 1px solid #ccc; }
        pre { padding: 1em; background: #f5f5f5; border-radius: 4px; overflow-x: auto; }
      ` : `
        body { margin: 0 !important; padding: 0 !important; background: white !important;
               width: 1080px !important; min-width: 1080px !important; overflow-x: hidden !important; }
      `
      document.head.appendChild(style)

      // Wiki 特定处理
      if (type === 'wiki') {
        const content = document.querySelector('#mw-content-text .mw-parser-output')
        const newBody = document.createElement('div')
        newBody.id = 'content'
        if (content) newBody.appendChild(content.cloneNode(true))
        document.body.innerHTML = ''
        document.body.appendChild(newBody)
      }
      // MCMOD 特定处理
      else if (url.includes('/item/')) {
        const maintext = document.querySelector('.maintext')
        const itemRow = document.querySelector('.item-row')
        if (maintext && itemRow) {
          maintext.setAttribute('style', 'margin:0 !important;padding:0 !important;float:none !important;width:100% !important;')
          itemRow.setAttribute('style', 'margin:0 auto !important;padding:20px !important;width:auto !important;max-width:1000px !important;background:white !important;')
        }
      }
    }, { type, url, selectors: CLEANUP_SELECTORS[type] })

    // 获取内容区域尺寸
    const dimensions = await page.evaluate((params) => {
      const { type, mainSelector } = params
      const element = type === 'wiki' ?
        document.querySelector('#content') :
        document.querySelector(mainSelector)

      if (!element) return null

      if (type === 'mcmod') {
        element.style.height = 'auto'
        element.style.overflow = 'visible'
        element.style.width = '1080px'
      }

      const rect = element.getBoundingClientRect()
      return {
        width: type === 'wiki' ? Math.min(1000, Math.ceil(rect.width)) : 1080,
        height: Math.min(type === 'wiki' ? 4000 : 6000,
                        type === 'wiki' ? Math.ceil(rect.height) : Math.max(800, Math.ceil(rect.height)))
      }
    }, { type, mainSelector })

    if (!dimensions) {
      throw new Error('无法获取页面内容区域')
    }

    // 截图
    await new Promise(resolve => setTimeout(resolve, 500))
    const screenshot = await page.screenshot({
      type: type === 'wiki' ? 'png' : 'jpeg',
      quality: type === 'wiki' ? undefined : 80,
      omitBackground: true,
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        ...dimensions
      }
    })

    return { image: screenshot, height: dimensions.height }
  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
  }
}

// 处理函数导出
export async function handleWikiScreenshot(keyword: string, url: string, lang: LangCode, config: MinecraftToolsConfig, ctx: any) {
  if (!config.wiki.imageEnabled) {
    throw new Error('图片功能已禁用')
  }

  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()
  try {
    const { image } = await capturePageScreenshot({
      url,
      page,
      config,
      type: 'wiki',
      lang
    })
    return {
      url,
      image: h.image(image, 'image/png')
    }
  } finally {
    await context.close()
  }
}

export async function handleModScreenshot(keyword: string, config: MinecraftToolsConfig, ctx: any) {
  const results = await searchMCMOD(keyword, config)
  if (!results.length) {
    throw new Error('未找到相关内容')
  }

  const result = results[0]
  if (!result.url) {
    throw new Error('获取链接失败')
  }

  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()
  try {
    const { image } = await capturePageScreenshot({
      url: result.url,
      page,
      config,
      type: 'mcmod'
    })
    return {
      url: result.url,
      image: h.image(image, 'image/jpeg')
    }
  } finally {
    await context.close()
  }
}
