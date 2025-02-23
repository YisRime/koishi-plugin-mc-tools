import { h } from 'koishi'
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

  // 移除:not(.notaninfobox)以获取完整内容
  $('#mw-content-text .mw-parser-output > *').each((_, element) => {
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
      if (text && !text.startsWith('[') &&
          !text.startsWith('跳转') &&
          !el.hasClass('quote') &&
          !el.hasClass('treeview')) {
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
        return `『${section.title}』${sectionText}${sectionText.length >= config.wiki.sectionPreviewLength && index > 0 ? '...' : ''}`
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
        pageUrl
      }
    }

    const { content, url } = await fetchWikiArticleContent(pageUrl, lang, config)
    return `${content}\n详细内容：${url}`

  } catch (error) {
    return error.message
  }
}
