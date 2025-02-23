import * as cheerio from 'cheerio'
import axios from 'axios'
import {
  MinecraftToolsConfig,
  LangCode,
} from './utils'

// 3. 配置和处理函数
// 修改 constructWikiUrl 函数,添加 variant 参数
export function constructWikiUrl(title: string, lang: LangCode | string, includeVariant = false) {
  let domain: string
  let variant: string = ''

  if (typeof lang === 'string') {
    if (lang.startsWith('zh')) {
      domain = 'zh.minecraft.wiki'
      variant = lang === 'zh' ? 'zh-cn' :
                lang === 'zh-hk' ? 'zh-hk' :
                lang === 'zh-tw' ? 'zh-tw' : 'zh-cn'
    } else {
      domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
    }
  }

  const baseUrl = `https://${domain}/w/${encodeURIComponent(title)}`
  return includeVariant && variant ? `${baseUrl}?variant=${variant}` : baseUrl
}

export function formatArticleTitle(data: any): string {
  if (!data) return '未知条目'

  const parts = []

  if (data.short_name) parts.push(`${data.short_name}`)
  if (data.subtitle) parts.push(` ${data.subtitle} | `)
  if (data.title) parts.push(`${data.title}`)

  return parts.join(' ')
}

export async function searchWikiArticles(keyword: string, searchResultLimit: number, pageTimeout: number) {
  try {
    // 修改搜索 URL 的构造，确保包含 variant
    const searchUrl = constructWikiUrl('api.php', 'zh', true).replace('/w/', '/')
      + `&action=opensearch&search=${encodeURIComponent(keyword)}&limit=${searchResultLimit}`
    const { data } = await axios.get(searchUrl, {
      timeout: pageTimeout * 1000
    })

    const [_, titles, urls] = data
    if (!titles?.length) return []
    return titles.map((title, i) => ({ title, url: urls[i] }))
  } catch (error) {
    throw new Error('搜索失败，请稍后重试')
  }
}

export async function fetchWikiArticleContent(pageUrl: string, lang: LangCode, config: MinecraftToolsConfig) {
  const variant = lang.startsWith('zh') ?
    (lang === 'zh' ? 'zh-cn' :
     lang === 'zh-hk' ? 'zh-hk' :
     lang === 'zh-tw' ? 'zh-tw' : 'zh-cn') : ''

  const requestUrl = pageUrl.includes('?') ? pageUrl : `${pageUrl}?variant=${variant}`

  const response = await axios.get(requestUrl, {
    params: {
      uselang: lang,
      setlang: lang
    }
  })
  const $ = cheerio.load(response.data)

  const title = $('#firstHeading').text().trim()
  const sections: { title?: string; content: string[] }[] = []
  let currentSection: { title?: string; content: string[] } = { content: [] }

  $('#mw-content-text .mw-parser-output').children().each((_, element) => {
    const el = $(element)

    if (el.is('h2, h3, h4')) {
      if (currentSection.content.length) {
        const totalLength = currentSection.content.join(' ').length
        if (totalLength >= config.wiki.minSectionLength) {
          sections.push(currentSection)
        }
      }
      currentSection = {
        title: el.find('.mw-headline').text().trim(),
        content: []
      }
    }
    else if (el.is('p, ul, ol')) {
      const text = el.text().trim()
      if (text && !text.startsWith('[') && !text.startsWith('跳转') && !el.hasClass('quote')) {
        const cleanText = text.replace(/\s+/g, ' ')
        currentSection.content.push(cleanText)
      }
    }
  })

  if (currentSection.content.length) {
    const totalLength = currentSection.content.join(' ').length
    if (totalLength >= config.wiki.minSectionLength) {
      sections.push(currentSection)
    }
  }

  if (!sections.length) {
    const cleanUrl = pageUrl.split('?')[0]
    return { title, content: `${title}：本页面目前没有内容。`, url: cleanUrl }
  }

  const formattedContent = sections
    .map((section, index) => {
      const sectionText = index === 0
        ? section.content.join(' ')
        : section.content.join(' ').slice(0, config.wiki.sectionPreviewLength)
      if (section.title) {
        return `${section.title} | ${sectionText}${sectionText.length >= config.wiki.sectionPreviewLength && index > 0 ? '...' : ''}`
      }
      return sectionText
    })
    .join('\n')
    .slice(0, config.wiki.totalPreviewLength)

  const cleanUrl = pageUrl.split('?')[0]
  return {
    title,
    content: formattedContent.length >= config.wiki.totalPreviewLength ? formattedContent + '...' : formattedContent,
    url: cleanUrl
  }
}

export async function captureWikiPageScreenshot(page: any, url: string, lang: LangCode, config: MinecraftToolsConfig) {
  const CLEANUP_SELECTORS = [
    '.mw-editsection', '#mw-navigation', '#footer', '.noprint', '#toc',
    '.navbox', '#siteNotice', '#contentSub', '.mw-indicators',
    '.sister-wiki', '.external', 'script', 'style', 'meta'
  ]

  try {
    // 设置初始视口
    await page.setViewport({
      width: 1000,
      height: 800,
      deviceScaleFactor: 1
    })

    // 设置语言和请求头
    await page.setExtraHTTPHeaders({
      'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
      'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`,
      'Cache-Control': 'no-cache'
    })

    // 页面加载与重试机制
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
    await page.waitForSelector('#bodyContent', {
      timeout: config.wiki.pageTimeout * 1000,
      visible: true
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
          max-width: 1000px;
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
        height: Math.min(4000, Math.ceil(rect.height)) // 限制最大高度
      }
    })

    if (!dimensions) {
      throw new Error('无法获取页面内容区域')
    }

    // 调整视口并截图
    await page.setViewport({
      width: dimensions.width,
      height: dimensions.height,
      deviceScaleFactor: 1
    })

    // 等待内容完全渲染
    await new Promise(resolve => setTimeout(resolve, 500))

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      omitBackground: true,
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: dimensions.width,
        height: dimensions.height
      }
    })

    return {
      image: screenshot,
      height: dimensions.height
    }
  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
  }
}

export async function processWikiRequest(keyword: string, userId: string, config: MinecraftToolsConfig, ctx: any, userLangs: Map<string, LangCode>, mode: 'text' | 'image' | 'search' = 'text') {
  if (!keyword) return '请输入要查询的内容关键词'

  try {
    const lang = userLangs.get(userId) || config.wiki.defaultLanguage
    const results = await searchWikiArticles(keyword, config.wiki.searchResultLimit, config.wiki.pageTimeout)

    if (!results.length) return `${keyword}：本页面目前没有内容。`

    if (mode === 'search') {
      return {
        results,
        domain: lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`,
        lang
      }
    }

    const result = results[0]
    const pageUrl = constructWikiUrl(result.title, lang, true)
    const displayUrl = constructWikiUrl(result.title, lang)

    if (mode === 'image') {
      return {
        url: displayUrl,
        async getImage() {
          const context = await ctx.puppeteer.browser.createBrowserContext()
          const page = await context.newPage()
          try {
            const { image } = await captureWikiPageScreenshot(page, pageUrl, lang, config)
            return { image }
          } finally {
            await context.close()
          }
        }
      }
    }

    const { title, content, url } = await fetchWikiArticleContent(pageUrl, lang, config)
    return `『${title}』${content}\n详细内容：${url}`

  } catch (error) {
    return error.message
  }
}
