import * as cheerio from 'cheerio'
import axios from 'axios'
import { h } from 'koishi'
import {
  formatErrorMessage,
  getWikiConfiguration,
  MinecraftToolsConfig,
  LangCode,
  constructWikiUrl,
  formatArticleTitle,
} from './utils'

// 通用的格式化详情函数
export const formatModItemDetails = ($: cheerio.CheerioAPI, isModpack = false) => {
  const contentSections: string[] = []

  // 提取标题信息
  const shortName = $('.short-name').first().text().trim()
  const title = $('.class-title h3').first().text().trim()
  const enTitle = $('.class-title h4').first().text().trim()

  // 获取状态文本（仅适用于mod）
  const modStatusLabels: string[] = []
  if (!isModpack) {
    $('.class-official-group .class-status').each((_, elem) => {
      modStatusLabels.push($(elem).text().trim())
    })
    $('.class-official-group .class-source').each((_, elem) => {
      modStatusLabels.push($(elem).text().trim())
    })
  }

  // 组合标题
  const formattedTitle = `${shortName} ${enTitle} | ${title}${!isModpack && modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''}`
  contentSections.push(formattedTitle)

  // 提取封面图片
  const coverImage = $('.class-cover-image img').first()
  if (coverImage.length) {
    const imgSrc = coverImage.attr('src')
    if (imgSrc) {
      const fullImgSrc = imgSrc.startsWith('http') ? imgSrc : `https:${imgSrc}`
      contentSections.push(h.image(fullImgSrc).toString())
    }
  }

  // 提取信息
  $('.class-info-left .col-lg-4').each((_, elem) => {
    const text = $(elem).text().trim()
      .replace(/\s+/g, ' ')
      .replace(/：/g, ': ')

    if (isModpack) {
      // 整合包只保留特定信息
      if (text.includes('整合包类型') ||
          text.includes('运作方式') ||
          text.includes('打包方式')) {
        contentSections.push(text)
      }
    } else {
      // mod只保留运行环境信息
      if (text.includes('运行环境')) {
        contentSections.push(text)
      }
    }
  })

  return contentSections
}

// 通用的版本信息格式化函数
export const formatModVersionInfo = ($: cheerio.CheerioAPI, isModpack = false) => {
  const contentSections: string[] = []

  if (isModpack) {
    // 整合包版本信息处理
    const versionInfo: string[] = []
    $('.mcver ul li').each((_, elem) => {
      const text = $(elem).text().trim()
      if (text && !text.includes('Forge:') && text.match(/^\d/)) {
        versionInfo.push(text)
      }
    })

    if (versionInfo.length) {
      contentSections.push('支持版本:')
      contentSections.push(versionInfo.join(', '))
    }
  } else {
    // MOD版本信息处理
    const versionInfo: Record<string, string[]> = {}
    $('.mcver ul').each((_, elem) => {
      const loaderText = $(elem).find('li:first').text().trim()
      const versions: string[] = []

      $(elem).find('a').each((_, verElem) => {
        const version = $(verElem).text().trim()
        if (version.match(/^\d/)) {
          versions.push(version)
        }
      })

      if (versions.length > 0) {
        const loader = loaderText.split(':')[0].trim()
        versionInfo[loader] = versions
      }
    })

    const versionTexts = Object.entries(versionInfo)
      .filter(([_, vers]) => vers.length > 0)
      .map(([loader, vers]) => `${loader}: ${vers.join(', ')}`)

    if (versionTexts.length) {
      contentSections.push('支持版本:')
      contentSections.push(versionTexts.join('\n'))
    }
  }

  return contentSections
}

// 格式化模组描述函数
export const formatModDescription = ($: cheerio.CheerioAPI, totalPreviewLength: number, type: 'mod' | 'modpack' | 'item' | 'post' = 'mod') => {
  const contentSections: string[] = []

  if (type === 'post') {
    // 提取帖子标题
    const title = $('.postname h5').text().trim()
    if (title) contentSections.push(title)

    // 处理帖子内容区域
    const contentArea = $('div.text')
    if (contentArea.length) {
      let totalLength = 0

      contentArea.find('p').each((_, pElem) => {
        const $pElem = $(pElem)
        if (totalLength >= totalPreviewLength) return false

        let text = $pElem.clone()
          .find('script, .figure')
          .remove()
          .end()
          .text()
          .trim()
          .replace(/\s+/g, ' ')
          .replace(/\[(\w+)\]/g, '')

        const title = $pElem.find('.common-text-title')
        if (title.length) {
          text = `『${title.text().trim()}』${text.replace(title.text().trim(), '')}`
        }

        if (text) {
          const remainingChars = totalPreviewLength - totalLength
          if (text.length > remainingChars) {
            text = text.slice(0, remainingChars) + '......'
            totalLength = totalPreviewLength
          } else {
            totalLength += text.length
          }
          contentSections.push(text)
        }

        const figure = $pElem.find('.figure')
        if (figure.length) {
          const img = figure.find('img')
          if (img.length) {
            let imgSrc = img.attr('data-src') || img.attr('src')
            if (imgSrc && !imgSrc.startsWith('http')) {
              imgSrc = `https:${imgSrc}`
            }
            if (imgSrc) {
              contentSections.push(h.image(imgSrc).toString())
            }
          }
        }
      })
    }
    return contentSections
  }

  if (type === 'item') {
    // 处理物品名称和图标
    const itemName = $('.itemname .name h5').text().trim()
    if (itemName) contentSections.push(itemName)

    const itemIcon = $('.item-info-table img').first()
    if (itemIcon.length) {
      const imgSrc = itemIcon.attr('src')
      if (imgSrc) {
        const fullImgSrc = imgSrc.startsWith('http') ? imgSrc : `https:${imgSrc}`
        contentSections.push(h.image(fullImgSrc).toString())
      }
    }

    contentSections.push('\n物品介绍:')
  }

  // 处理内容区域
  const contentArea = type === 'item' ? $('.item-content.common-text') : $('.common-text')

  if (contentArea.length) {
    if (type !== 'item') {
      contentSections.push(`\n${type === 'modpack' ? '整合包' : '模组'}介绍:`)
    }

    let totalLength = 0
    let skipNext = false

    contentArea.children().each((_, elem) => {
      const $elem = $(elem)

      // 统一应用字数限制
      if (totalLength >= totalPreviewLength) return false

      if (skipNext) {
        skipNext = false
        return
      }

      // 处理图片
      const figure = $elem.find('.figure')
      if (figure.length) {
        const img = figure.find('img')
        if (img.length) {
          let imgSrc = img.attr('data-src') || img.attr('src')
          if (imgSrc && !imgSrc.startsWith('http')) {
            imgSrc = `https:${imgSrc}`
          }
          if (imgSrc) {
            contentSections.push(h.image(imgSrc).toString())
          }
        }
        return
      }

      if ($elem.is('p, ol, ul')) {
        const title = $elem.find('span.common-text-title')
        if (title.length) {
          const nextP = $elem.next('p')
          if (nextP.length) {
            const nextText = nextP.clone()
              .find('script,.figure').remove().end()
              .text()
              .trim()
              .replace(/\s+/g, ' ')
              .replace(/\[(\w+)\]/g, '')

            if (nextText) {
              let combinedText = `『${title.text().trim()}』${nextText}`
              const remainingChars = totalPreviewLength - totalLength
              if (combinedText.length > remainingChars) {
                combinedText = combinedText.slice(0, remainingChars) + '......'
                totalLength = totalPreviewLength
              } else {
                totalLength += combinedText.length
              }
              contentSections.push(combinedText)
              skipNext = true
            } else {
              contentSections.push(`『${title.text().trim()}』`)
            }
            return
          } else {
            contentSections.push(`『${title.text().trim()}』`)
            return
          }
        }

        let text = $elem.clone()
          .find('script,.figure').remove().end()
          .text()
          .trim()
          .replace(/\s+/g, ' ')
          .replace(/\[(\w+)\]/g, '')

        if (text) {
          const remainingChars = totalPreviewLength - totalLength
          if (text.length > remainingChars) {
            text = text.slice(0, remainingChars) + '......'
            totalLength = totalPreviewLength
          } else {
            totalLength += text.length
          }
          contentSections.push(text)
        }
      }
    })
  }

  return contentSections
}

// 搜索结果处理函数
export const processModSearchResult = async (url: string, totalPreviewLength: number) => {
  const response = await axios.get(url)
  const $ = cheerio.load(response.data)
  const contentSections: string[] = []
  const isModpack = url.includes('/modpack/')

  contentSections.push(
    ...formatModItemDetails($, isModpack),
    ...formatModVersionInfo($, isModpack),
    ...formatModDescription($, totalPreviewLength, isModpack ? 'modpack' : 'mod')
  )

  contentSections.push(`\n详细内容: ${url}`)

  return contentSections
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 物品搜索结果处理函数
export const processItemSearchResult = async (url: string, totalPreviewLength: number) => {
  const response = await axios.get(url)
  const $ = cheerio.load(response.data)
  const contentSections = formatModDescription($, totalPreviewLength, 'item')

  contentSections.push(`\n详细内容: ${url}`)

  return contentSections
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 帖子处理函数
export const processPostSearchResult = async (url: string, totalPreviewLength: number) => {
  const response = await axios.get(url)
  const $ = cheerio.load(response.data)
  const contentSections = formatModDescription($, totalPreviewLength, 'post')

  contentSections.push(`\n详细内容: ${url}`)

  return contentSections
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 5. Wiki 相关函数
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

export async function searchModDatabase(keyword: string, apiBase: string) {
  const results = await axios.get(`${apiBase}/s/key=${encodeURIComponent(keyword)}`)
  if (!results.data?.length) return null
  return results.data
}

export async function fetchModDetails(id: number, type: string, apiBase: string) {
  const { data } = await axios.get(`${apiBase}/d/${type}/${id}`)
  return data
}

export async function formatModDetails(result: any, config: MinecraftToolsConfig) {
  if (!result.data?.mcmod_id) {
    return `${result.title}\n${result.description}`
  }

  try {
    const type = result.address?.includes('/modpack/') ? 'modpack' : 'class'
    const { data } = await axios.get(`wiki/d/${type}/${result.data.mcmod_id}`)

    const lines = []

    if (data.cover_image) {
      lines.push(h.image(data.cover_image).toString())
    }

    lines.push(formatArticleTitle(data))

    const infoItems = []
    if (data.operating_environment) infoItems.push(`运行环境：${data.operating_environment}`)

    if (data.supported_versions) {
      const versions = Object.entries(data.supported_versions)
        .filter(([_, vers]) => Array.isArray(vers) && vers.length)
        .map(([platform, vers]) => {
          const sortedVers = (vers as string[]).sort((a, b) => {
            return /^\d/.test(a) && /^\d/.test(b) ? b.localeCompare(a, undefined, { numeric: true }) : 0
          })
          return `${platform}(${sortedVers.join(', ')})`
        })

      if (versions.length) {
        infoItems.push(`支持版本：${versions.join(' | ')}`)
      }
    }

    if (infoItems.length) {
      lines.push('', ...infoItems)
    }

    if (result.address) {
      lines.push('', `详情页面：${result.address}`)
    }

    return lines.join('\n')

  } catch (error) {
    throw new Error(`获取${result.address?.includes('/modpack/') ? '整合包' : '模组'}详情失败: ${formatErrorMessage(error)}`)
  }
}

// 6. 主要业务逻辑函数
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

export async function captureWikiPageScreenshot(page: any, url: string, lang: LangCode, config: MinecraftToolsConfig) {
  try {
    await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })
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
