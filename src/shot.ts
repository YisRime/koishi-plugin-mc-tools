import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'

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

/**
 * 通用截图处理函数
 */
async function capturePageScreenshot(params: {
  page: any
  url: string
  config: MinecraftToolsConfig
  type: 'wiki' | 'mcmod'
  lang?: LangCode
}) {
  const { page, url, type, lang } = params

  try {
    // 设置公共请求头和重试机制
    if (type === 'wiki' && lang) {
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`,
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
    if (type === 'wiki') {
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

      // 清理Wiki特定元素
      await page.evaluate((selectors) => {
        selectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => el.remove())
        })
      }, CLEANUP_SELECTORS)

    } else {
      const pageType = url.includes('/item/') ? 'item' : 'other'
      const mainSelector = pageType === 'item' ? '.item-row' : '.col-lg-12.right'

      await page.waitForSelector(mainSelector, { timeout: 10000, visible: true })

      // 处理MCMOD页面内容
      await page.evaluate(() => {
        // 移除不需要的元素
        document.querySelectorAll(`
          header, footer, .header-container,
          .common-nav, .common-menu-page,
          .comment-ad, .ad-leftside, .slidetips,
          .common-icon-text-frame, script,
          .ad-class-page,
          .common-ad-frame,
          .item-table-tips
        `).forEach(el => el.remove())

        if(document.querySelector('.item-row')) {
          // 调整物品页面布局
          document.querySelector('.item-row').setAttribute('style', 'margin:0 !important; padding:20px !important; width:auto !important; background:white !important;')
          document.querySelector('.maintext').setAttribute('style', 'margin:0 !important; float:none !important; width:100% !important;')
        }
      })

    }

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
    const clipData = await page.evaluate((isWiki) => {
      const selector = isWiki ? '#content' : '.item-row, .col-lg-12.right'
      const element = document.querySelector(selector)
      if (!element) return null

      const rect = element.getBoundingClientRect()
      return {
        x: Math.max(0, Math.floor(rect.left)),
        y: Math.max(0, Math.floor(rect.top)),
        width: Math.min(1080, Math.ceil(rect.width)),
        height: Math.min(4096, Math.ceil(rect.height))
      }
    }, type === 'wiki')

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
      image: screenshot,
      height: clipData.height
    }

  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
  }
}

export async function capture(
  url: string,
  config: MinecraftToolsConfig,
  ctx: any,
  options: {
    type: 'wiki' | 'mcmod'
    lang?: LangCode
  }
) {
  if (!config.wiki.imageEnabled) {
    throw new Error('图片功能已禁用')
  }

  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()
  try {
    const { image } = await capturePageScreenshot({
      page,
      url,
      config,
      ...options
    })
    return {
      url,
      image: h.image(image, 'image/jpeg')
    }
  } finally {
    await context.close()
  }
}
