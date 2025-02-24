import * as cheerio from 'cheerio'
import axios from 'axios'
import { MinecraftToolsConfig, LangCode } from './utils'
import { searchWikiArticles } from './search'

// 3. 配置和处理函数
export function constructWikiUrl(articleTitle: string, languageCode: LangCode | string, includeLanguageVariant = false) {
  let wikiDomain: string
  let languageVariant: string = ''

  if (typeof languageCode === 'string') {
    if (languageCode.startsWith('zh')) {
      wikiDomain = 'zh.minecraft.wiki'
      languageVariant = languageCode === 'zh' ? 'zh-cn' :
                languageCode === 'zh-hk' ? 'zh-hk' :
                languageCode === 'zh-tw' ? 'zh-tw' : 'zh-cn'
    } else {
      wikiDomain = languageCode === 'en' ? 'minecraft.wiki' : `${languageCode}.minecraft.wiki`
    }
  }

  const baseUrl = `https://${wikiDomain}/w/${encodeURIComponent(articleTitle)}`
  return includeLanguageVariant && languageVariant ? `${baseUrl}?variant=${languageVariant}` : baseUrl
}

export function formatArticleTitle(data: any): string {
  if (!data) return '未知条目'

  const parts = []

  if (data.title) parts.push(`${data.title}`)

  return parts.join(' ')
}

export async function fetchWikiArticleContent(articleUrl: string, languageCode: LangCode, config: MinecraftToolsConfig) {
  const languageVariant = languageCode.startsWith('zh') ?
    (languageCode === 'zh' ? 'zh-cn' :
     languageCode === 'zh-hk' ? 'zh-hk' :
     languageCode === 'zh-tw' ? 'zh-tw' : 'zh-cn') : ''

  const requestUrl = articleUrl.includes('?') ? articleUrl : `${articleUrl}?variant=${languageVariant}`

  const response = await axios.get(requestUrl, {
    params: {
      uselang: languageCode,
      setlang: languageCode
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
    const cleanUrl = articleUrl.split('?')[0]
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

  const cleanUrl = articleUrl.split('?')[0]
  return {
    title,
    content: formattedContent.length >= config.wiki.totalPreviewLength ? formattedContent + '...' : formattedContent,
    url: cleanUrl
  }
}

export async function processWikiRequest(keyword: string, userId: string, config: MinecraftToolsConfig, userLangs: Map<string, LangCode>, mode: 'text' | 'image' | 'search' = 'text') {
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
