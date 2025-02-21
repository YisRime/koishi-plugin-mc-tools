import * as cheerio from 'cheerio'
import axios from 'axios'
import {
  formatErrorMessage,
  MinecraftToolsConfig,
  LangCode,
} from './utils'

// 3. 配置和处理函数
export function getWikiConfiguration(lang: LangCode) {
  let domain: string
  let variant: string = ''

  if (lang.startsWith('zh')) {
    domain = 'zh.minecraft.wiki'
    variant = lang === 'zh' ? 'zh-cn' : 'zh-hk'
  } else {
    domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
  }

  return { domain, variant }
}

export function constructWikiUrl(title: string, domain: string, variant?: string, includeVariant = false) {
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
  const { domain } = getWikiConfiguration('zh')
  try {
    const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${searchResultLimit}&variant=zh-cn`
    const { data } = await axios.get(searchUrl, {
      params: { variant: 'zh-cn' },
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
  const { variant } = getWikiConfiguration(lang)
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
  try {
    await page.setViewport({
      width: config.wiki.imageMaxWidth,
      height: 800,
      deviceScaleFactor: config.wiki.imagePriority
    })
    await page.setExtraHTTPHeaders({
      'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
      'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`
    })

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: config.wiki.pageTimeout * 1000
    })

    await page.waitForSelector('#bodyContent', { timeout: config.wiki.pageTimeout * 1000 })

    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        body { margin: 0; background: white; font-family: system-ui, -apple-system, sans-serif; }
        #content { margin: 0; padding: 20px; box-sizing: border-box; width: 1000px; }
        .notaninfobox { float: none !important; margin: 1em auto !important; width: auto !important; max-width: 300px; }
        .mw-parser-output { max-width: 960px; margin: 0 auto; line-height: 1.6; }
        img { max-width: 100%; height: auto; }
        table { margin: 1em auto; border-collapse: collapse; }
        td, th { padding: 0.5em; border: 1px solid #ccc; }
        pre { padding: 1em; background: #f5f5f5; border-radius: 4px; overflow-x: auto; }
      `
      document.head.appendChild(style)

      const selectors = [
        '.mw-editsection', '#mw-navigation', '#footer', '.noprint', '#toc',
        '.navbox', '#siteNotice', '#contentSub', '.mw-indicators',
        '.sister-wiki', '.external'
      ]
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
    })

    await page.evaluate((tags: string[]) => {
      tags.forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove())
      })
    }, config.wiki.cleanupTags)

    const dimensions = await page.evaluate(() => {
      const content = document.querySelector('#content')
      if (!content) return null
      const rect = content.getBoundingClientRect()
      return {
        width: Math.min(1000, Math.ceil(rect.width)),
        height: Math.ceil(rect.height)
      }
    })

    if (!dimensions) {
      throw new Error('无法获取页面内容')
    }

    await page.setViewport({
      width: dimensions.width,
      height: dimensions.height,
      deviceScaleFactor: 1
    })

    const screenshot = await page.screenshot({
      type: 'png',
      quality: config.wiki.imageQuality,
      omitBackground: true,
      fullPage: false
    })

    return {
      image: screenshot,
      height: dimensions.height
    }
  } catch (error) {
    throw error
  }
}

export async function processWikiRequest(keyword: string, userId: string, config: MinecraftToolsConfig, ctx: any, userLangs: Map<string, LangCode>, mode: 'text' | 'image' | 'search' = 'text') {
  if (!keyword) return '请输入要查询的内容关键词'

  try {
    const lang = userLangs.get(userId) || config.wiki.defaultLanguage
    const results = await searchWikiArticles(keyword, config.wiki.searchResultLimit, config.wiki.pageTimeout)

    if (!results.length) return `${keyword}：本页面目前没有内容。`

    const { domain, variant } = getWikiConfiguration(lang)

    if (mode === 'search') {
      return {
        results,
        domain,
        lang
      }
    }

    const result = results[0]
    const pageUrl = constructWikiUrl(result.title, domain, variant, true)
    const displayUrl = constructWikiUrl(result.title, domain)

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
    return formatErrorMessage(error)
  }
}
