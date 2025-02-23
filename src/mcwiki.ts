import * as cheerio from 'cheerio'
import axios from 'axios'
import { Context } from 'koishi'
import { formatErrorMessage, MinecraftToolsConfig, LangCode } from './utils'

// 合并 Wiki 配置和 URL 处理相关函数
export function getWikiConfiguration(lang: LangCode) {
  const config = {
    domain: lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`,
    variant: '',
    baseApiUrl: ''
  }

  if (lang.startsWith('zh')) {
    config.domain = 'zh.minecraft.wiki'
    config.variant = lang === 'zh' ? 'zh-cn' : 'zh-hk'
  }

  config.baseApiUrl = `https://${config.domain}/api.php`
  return config
}

export function constructUrl(config: ReturnType<typeof getWikiConfiguration>, path: string, includeVariant = false) {
  const baseUrl = `https://${config.domain}${path}`
  return includeVariant && config.variant ? `${baseUrl}?variant=${config.variant}` : baseUrl
}

// 统一的内容处理接口
async function processWikiContent(url: string, lang: LangCode, config: MinecraftToolsConfig) {
  const { variant } = getWikiConfiguration(lang)
  const requestUrl = url.includes('?') ? url : `${url}?variant=${variant}`

  const $ = await fetchAndParse(requestUrl, lang)
  const title = $('#firstHeading').text().trim()
  const sections = extractSections($, config.wiki.minSectionLength)

  if (!sections.length) {
    return { title, content: `${title}：本页面目前没有内容。`, url: url.split('?')[0] }
  }

  const content = formatSections(sections, config.wiki.sectionPreviewLength, config.wiki.totalPreviewLength)
  return { title, content, url: url.split('?')[0] }
}

async function fetchAndParse(url: string, lang: LangCode) {
  const response = await axios.get(url, {
    params: { uselang: lang, setlang: lang }
  })
  return cheerio.load(response.data)
}

function extractSections($: cheerio.CheerioAPI, minLength: number) {
  const sections: { title?: string; content: string[] }[] = []
  let currentSection: { title?: string; content: string[] } = { content: [] as string[] }

  $('#mw-content-text .mw-parser-output').children().each((_, element) => {
    const el = $(element)

    if (el.is('h2, h3, h4')) {
      if (isValidSection(currentSection, minLength)) {
        sections.push(currentSection)
      }
      currentSection = {
        title: el.find('.mw-headline').text().trim(),
        content: []
      }
    }
    else if (el.is('p, ul, ol')) {
      const text = cleanupText(el.text())
      if (text) currentSection.content.push(text)
    }
  })

  if (isValidSection(currentSection, minLength)) {
    sections.push(currentSection)
  }

  return sections
}

function isValidSection(section: { content: string[] }, minLength: number) {
  return section.content.length > 0 &&
         section.content.join(' ').length >= minLength
}

function cleanupText(text: string) {
  const cleaned = text.trim()
    .replace(/\s+/g, ' ')
    .replace(/\[\d+\]/g, '')
  return cleaned && !cleaned.startsWith('跳转') ? cleaned : ''
}

function formatSections(
  sections: { title?: string; content: string[] }[],
  sectionPreviewLength: number,
  totalPreviewLength: number
) {
  const formatted = sections
    .map((section, index) => {
      const content = section.content.join(' ')
      const text = index === 0 ? content : content.slice(0, sectionPreviewLength)
      const ellipsis = text.length >= sectionPreviewLength && index > 0 ? '...' : ''

      return section.title
        ? `${section.title} | ${text}${ellipsis}`
        : text
    })
    .join('\n')
    .slice(0, totalPreviewLength)

  return formatted.length >= totalPreviewLength ? formatted + '...' : formatted
}

// 优化的截图处理逻辑
async function captureWikiPage(page: any, url: string, lang: LangCode, config: MinecraftToolsConfig) {
  const cleanup = [
    '.mw-editsection', '#mw-navigation', '#footer', '.noprint', '#toc',
    '.navbox', '#siteNotice', '#contentSub', '.mw-indicators',
    '.sister-wiki', '.external'
  ]

  await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })
  await page.setExtraHTTPHeaders({
    'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
    'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`
  })

  await page.goto(url, {
    waitUntil: 'networkidle0',
    timeout: config.wiki.pageTimeout * 1000
  })

  await page.evaluate((selectors: string[]) => {
    const style = document.createElement('style')
    style.textContent = `
      body { margin: 0; background: white; font-family: system-ui, -apple-system, sans-serif; }
      #content { margin: 0; padding: 20px; box-sizing: border-box; width: 1000px; }
      .mw-parser-output { max-width: 960px; margin: 0 auto; line-height: 1.6; }
      img { max-width: 100%; height: auto; }
      table { margin: 1em auto; border-collapse: collapse; }
      td, th { padding: 0.5em; border: 1px solid #ccc; }
    `
    document.head.appendChild(style)
    selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
  }, cleanup)

  const dimensions = await page.evaluate(() => {
    const content = document.querySelector('#content')
    return content ? {
      width: Math.min(1000, Math.ceil(content.getBoundingClientRect().width)),
      height: Math.ceil(content.getBoundingClientRect().height)
    } : null
  })

  if (!dimensions) throw new Error('无法获取页面内容')

  await page.setViewport(dimensions)
  return await page.screenshot({ type: 'png', omitBackground: true })
}

// 主要的处理函数
export async function processWikiRequest(
  keyword: string,
  config: MinecraftToolsConfig,
  ctx?: Context,
  mode: 'text' | 'image' | 'search' = 'text'
) {
  if (!keyword) return '请输入要查询的 Wiki 关键词'

  try {
    const wikiConfig = getWikiConfiguration(config.wiki.defaultLanguage)
    const searchUrl = `${wikiConfig.baseApiUrl}?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.wiki.searchResultLimit}&variant=${wikiConfig.variant}`

    const { data: [_, titles, urls] } = await axios.get(searchUrl)
    if (!titles?.length) return `未找到与"${keyword}"相关的 Wiki 条目`

    const results = titles.map((title, i) => ({ title, url: urls[i] }))
    if (mode === 'search') return { results, ...wikiConfig }

    const result = results[0]
    const pageUrl = constructUrl(wikiConfig, `/w/${encodeURIComponent(result.title)}`, true)

    if (mode === 'image') {
      if (!ctx?.puppeteer) throw new Error('截图功能不可用：未找到 puppeteer 服务')

      return {
        url: constructUrl(wikiConfig, `/w/${encodeURIComponent(result.title)}`),
        async getImage() {
          const context = await ctx.puppeteer.browser.createBrowserContext()
          const page = await context.newPage()
          try {
            const image = await captureWikiPage(page, pageUrl, config.wiki.defaultLanguage, config)
            return { image }
          } finally {
            await context.close()
          }
        }
      }
    }

    const { title, content, url } = await processWikiContent(pageUrl, config.wiki.defaultLanguage, config)
    return `『${title}』${content}\n详细内容：${url}`

  } catch (error) {
    return `Wiki 查询失败：${formatErrorMessage(error)}`
  }
}
