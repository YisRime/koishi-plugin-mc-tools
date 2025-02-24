import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'
import { searchMCMOD } from './search'

// 通用截图清理选择器
const CLEANUP_SELECTORS = [
  '.mw-editsection',  // 编辑节按钮
  '#mw-navigation',   // 导航
  '#footer',          // 页脚
  '.noprint',         // 不可打印内容
  '#toc',            // 目录
  '.navbox',         // 导航框
  '#siteNotice',     // 站点通知
  '#contentSub',     // 子标题
  '.mw-indicators', // 指示器
  '.sister-wiki',    // 姊妹维基链接
  '.external',      // 外部链接
  'script',         // 脚本
  'meta',           // 元数据
  '#mw-head',       // 页面头部
  '#mw-head-base',  // 头部基础
  '#mw-page-base',  // 页面基础
  '#catlinks',      // 分类链接
  '.printfooter',   // 打印页脚
  '.mw-jump-link',  // 跳转链接
  '.vector-toc',    // 矢量目录
  '.vector-menu',   // 矢量菜单
  '.mw-cite-backlink', // 引用回链
  '.reference',     // 引用
  '.treeview',      // 树状视图
  '.file-display-header' // 文件显示头部
]


// 提取通用的页面加载逻辑
async function loadPage(page: any, url: string, timeout: number) {
  let retries = 3
  while (retries > 0) {
    try {
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: timeout * 1000
      })
      break
    } catch (err) {
      retries--
      if (retries === 0) throw err
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

// 提取通用的截图配置
async function takeScreenshot(page: any, dimensions: { width: number, height: number }) {
  await page.setViewport({
    width: dimensions.width,
    height: dimensions.height,
    deviceScaleFactor: 1
  })

  await new Promise(resolve => setTimeout(resolve, 500))

  return await page.screenshot({
    type: 'jpeg',
    quality: 80,
    omitBackground: true,
    fullPage: false,
    clip: {
      x: 0,
      y: 0,
      ...dimensions
    }
  })
}

export async function captureWikiPageScreenshot(page: any, url: string, lang: LangCode, config: MinecraftToolsConfig) {
  try {
    await page.setViewport({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1
    })

    await page.setExtraHTTPHeaders({
      'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
      'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`,
      'Cache-Control': 'no-cache'
    })

    await loadPage(page, url, config.wiki.pageTimeout)

    // 等待内容加载
    await page.waitForSelector('#bodyContent', {
      timeout: config.wiki.pageTimeout * 1000,
      visible: true
    })

    // 只保留正文内容
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

    // 注入优化样式
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        body {
          margin: 0;
          background: white;
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

    // 清理无用元素
    await page.evaluate((selectors) => {
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
    }, CLEANUP_SELECTORS)

    // 获取内容区域尺寸
    const dimensions = await page.evaluate(() => {
      const content = document.querySelector('#content')
      if (!content) return null
      const rect = content.getBoundingClientRect()
      return {
        width: Math.min(1000, Math.ceil(rect.width)),
        height: Math.min(4000, Math.ceil(rect.height))
      }
    })

    if (!dimensions) {
      throw new Error('无法获取页面内容区域')
    }

    const screenshot = await takeScreenshot(page, dimensions)

    return {
      image: screenshot,
      height: dimensions.height
    }
  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
  }
}

export async function captureMCMODPageScreenshot(page: any, url: string, config: MinecraftToolsConfig) {
  try {
    await page.setViewport({
      width: 1080,
      height: 800,
      deviceScaleFactor: 1
    })

    await loadPage(page, url, config.wiki.pageTimeout)

    const pageType = url.includes('/item/') ? 'item' : 'other'
    const mainSelector = pageType === 'item' ? '.maintext' : '.col-lg-12.center'

    await page.waitForSelector(mainSelector, {
      timeout: config.wiki.pageTimeout * 1000,
      visible: true
    })

    // 注入优化样式
    await page.evaluate((type) => {
      const style = document.createElement('style')
      style.textContent = `
        body { margin: 0 !important; padding: 0 !important; background: white !重要; width: 1080px !重要; min-width: 1080px !重要; overflow-x: hidden !重要; }
        // ...existing code...
      `
      document.head.appendChild(style)

      document.querySelectorAll(`
        header, footer, .header-container, .common-background,
        .common-nav, .common-menu-page, .common-comment-block,
        .comment-ad, .ad-leftside, .slidetips, .item-table-tips,
        .common-icon-text-frame, script, .common-ad-frame,
        .ad-class-page, .item-data
      `).forEach(el => el.remove())

      if (type === 'item') {
        const maintext = document.querySelector('.maintext')
        const itemRow = document.querySelector('.item-row')
        if (maintext && itemRow) {
          maintext.setAttribute('style', 'margin:0 !重要;padding:0 !重要;float:none !重要;width:100% !重要;')
          itemRow.setAttribute('style', 'margin:0 auto !重要;padding:20px !重要;width:auto !重要;max-width:1000px !重要;background:white !重要;')
        }
      }
    }, pageType)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const clipData = await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      if (!element) return null

      element.style.height = 'auto'
      element.style.overflow = 'visible'
      element.style.width = '1080px'

      const rect = element.getBoundingClientRect()
      return {
        x: 0,
        y: Math.max(0, Math.floor(rect.top)),
        width: 1080,
        height: Math.min(6000, Math.max(800, Math.ceil(rect.height)))
      }
    }, mainSelector)

    if (!clipData) {
      throw new Error('无法获取页面内容区域')
    }

    const screenshot = await takeScreenshot(page, clipData)

    return {
      image: screenshot,
      height: clipData.height
    }
  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
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
    const imageResult = await captureMCMODPageScreenshot(page, result.url, config)
    return {
      url: result.url,
      image: h.image(imageResult.image, 'image/jpeg')
    }
  } finally {
    await context.close()
  }
}

export async function handleWikiScreenshot(keyword: string, url: string, lang: LangCode, config: MinecraftToolsConfig, ctx: any) {
  if (!config.wiki.imageEnabled) {
    throw new Error('图片功能已禁用')
  }

  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()
  try {
    const { image } = await captureWikiPageScreenshot(page, url, lang, config)
    return {
      url,
      image: h.image(image, 'image/png')
    }
  } finally {
    await context.close()
  }
}
