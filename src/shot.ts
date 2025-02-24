import { h } from 'koishi'
import { MinecraftToolsConfig, LangCode } from './utils'
import { searchMCMOD } from './search'

// 通用清理选择器
const CLEANUP_SELECTORS = {
  wiki: [
    // 导航和页面结构
    '#mw-navigation',
    '#mw-head',
    '#mw-head-base',
    '#mw-page-base',
    '#footer',
    '.vector-toc',
    '.vector-menu',

    // 元数据和引用
    '.mw-editsection',
    '.mw-indicators',
    '#contentSub',
    '#siteNotice',
    '.printfooter',
    '.catlinks',
    '.sister-wiki',

    // 页面内容清理
    '.noprint',
    '.treeview',
    '.mw-cite-backlink',
    '.reference',
    '.mw-jump-link',
    '.external',

    // 媒体相关
    '.file-display-header',

    // 交互和脚本
    'script',
    'meta',
    '.dismissable-site-notice'
  ],
  mcmod: [
    '.header-container',
    '.common-nav',
    '.class-menu-page',
    '.common-menu-side',
    '.class-edit-block',
    '.common-comment-block',
    '.common-scroll-top',
    '.common-share-block',
    '.info-footer',
    '.common-background',
    '.common-menu-main .text-area .common-text-title',
    '.common-menu-main .text-area .common-tag-ban',
    '.common-rowlist-block',
    '.common-imglist-block',
    'footer',
    'script',
    '.header-mobilemenu',
    '.class-info-right',
    '.class-info-side',
    '.edit-history',
    '.comment-ad',
    '.ad',
    '.ad-leftside',
    '.ad-class-page',
    '.item-data',
    '.item-stats'
  ]
}

/**
 * 截图选项接口
 */
interface ScreenshotOptions {
  /** 目标页面URL */
  url: string
  /** Puppeteer页面实例 */
  page: any
  /** 插件配置 */
  config: MinecraftToolsConfig
  /** 页面类型 */
  type: 'wiki' | 'mcmod'
  /** 语言代码 */
  lang?: LangCode
}

/**
 * 统一的网页截图处理函数
 * @param {ScreenshotOptions} options - 截图选项
 * @returns {Promise<{image: Buffer, height: number}>}
 */
async function capturePageScreenshot({ url, page, config, type, lang }: ScreenshotOptions) {
  try {
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
          timeout: 30000
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
      timeout: 30000,
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
        #content { margin: 0; padding: 0; box-sizing: border-box; width: 100%; }
        .mw-parser-output { margin: 0; padding: 20px 0; line-height: 1.6; }
        img { max-width: 100%; height: auto; }
        table { margin: 1em 0; border-collapse: collapse; max-width: 100%; }
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
        if (!content) throw new Error('找不到页面内容')

        // 创建新的内容容器
        const wrapper = document.createElement('div')
        wrapper.id = 'content'

        // 添加样式
        wrapper.setAttribute('style', `
          max-width: 960px;
          margin: 0 auto;
          padding: 2em;
          background: white;
          box-sizing: border-box;
        `)

        // 移除广告和无用内容
        content.querySelectorAll('.mcf-card').forEach(el => el.remove())
        content.querySelectorAll('ins.adsbygoogle').forEach(el => el.remove())

        // 优化图片显示
        content.querySelectorAll('img').forEach(img => {
          img.style.maxWidth = '100%'
          img.style.height = 'auto'
          img.style.margin = '0.5em auto'
          img.style.display = 'block'
        })

        // 优化表格显示
        content.querySelectorAll('table').forEach(table => {
          table.style.margin = '1em 0'
          table.style.width = '100%'
          table.style.borderCollapse = 'collapse'
        })

        // 清理body并添加新容器
        wrapper.appendChild(content.cloneNode(true))
        document.body.innerHTML = ''
        document.body.appendChild(wrapper)
      }
      // MCMOD 特定处理
      else {
        // 清理主内容区域
        if (document.querySelector('.col-lg-12.center')) {
          const center = document.querySelector('.col-lg-12.center')
          center.setAttribute('style',
            'margin:0 auto !important;' +
            'padding:20px !important;' +
            'width:1080px !important;' +
            'background:white !important;' +
            'min-height:unset !important'
          )

          // 调整文章内容区域
          const content = center.querySelector('.common-text') || center.querySelector('.maintext')
          if (content) {
            content.setAttribute('style',
              'margin:0 !important;' +
              'padding:0 !important;' +
              'width:100% !important;' +
              'float:none !important'
            )

            // 处理物品信息表格
            const infoTable = content.querySelector('.class-table')
            if (infoTable) {
              infoTable.setAttribute('style',
                'margin:1em 0 !important;' +
                'width:100% !important'
              )
            }
          }

          // 调整图片区域
          const imgArea = center.querySelector('.common-image-block')
          if (imgArea) {
            imgArea.setAttribute('style',
              'margin:1em 0 !important;' +
              'text-align:center !important'
            )
          }
        }

        // 处理图片
        document.querySelectorAll('img').forEach(img => {
          img.style.maxWidth = '100%'
          img.style.height = 'auto'
          img.style.margin = '0.5em'
        })

        // 移除背景
        const bg = document.querySelector('.common-background')
        if (bg) bg.remove()
      }
    }, { type, selectors: CLEANUP_SELECTORS[type] })

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

/**
 * 处理 Wiki 页面截图
 * @param {string} keyword - 搜索关键词
 * @param {string} url - Wiki页面URL
 * @param {LangCode} lang - 语言代码
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {any} ctx - Koishi上下文
 * @returns {Promise<{url: string, image: any}>}
 */
export async function handleWikiScreenshot(
  keyword: string,
  url: string,
  lang: LangCode,
  config: MinecraftToolsConfig,
  ctx: any
) {
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

/**
 * 处理 MCMOD 页面截图
 * @param {string} keyword - 搜索关键词
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {any} ctx - Koishi上下文
 * @returns {Promise<{url: string, image: any}>}
 */
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
