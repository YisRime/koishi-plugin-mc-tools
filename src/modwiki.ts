import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'

// 基础类型定义
export interface ModwikiConfig {
  searchDescLength: number
  totalPreviewLength: number
  searchTimeout: number
  searchResultLimit: number
  pageTimeout: number
}

// 内容处理函数
export async function processMCMODContent(url: string, config: ModwikiConfig) {
  try {
    const response = await axios.get(url, {
      timeout: config.pageTimeout * 1000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const $ = cheerio.load(response.data)

    // 检查页面是否存在
    if ($('.class-404').length > 0) {
      throw new Error('页面不存在')
    }

    const processor = getContentProcessor(url)
    const result = processor($, config.totalPreviewLength)

    // 验证处理结果
    if (!result || !result.sections || result.sections.length === 0) {
      throw new Error('无法解析页面内容')
    }

    return result
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('请求超时，请稍后重试')
      }
      throw new Error(`获取内容失败: ${error.message}`)
    }
    throw new Error(`内容处理失败: ${error.message}`)
  }
}

// 搜索结果处理函数组
export const processModSearchResult = async (url: string, config: ModwikiConfig) =>
  formatContentSections(await processMCMODContent(url, config), url)

export const processItemSearchResult = processModSearchResult
export const processPostSearchResult = processModSearchResult

// 工具函数
function normalizeUrl(url: string): string {
  return url.startsWith('http') ? url : `https://www.mcmod.cn${url}`
}

function getContentType(url: string): string {
  const types = {
    '/modpack/': '整合包',
    '/class/': 'MOD',
    '/item/': '物品',
    '/post/': '教程'
  }
  return Object.entries(types).find(([key]) => url.includes(key))?.[1] || '未知'
}

// 处理函数映射
function getContentProcessor(url: string) {
  if (url.includes('/post/')) return processPost
  if (url.includes('/item/')) return processItem
  return (($: cheerio.CheerioAPI, length: number) =>
    processMod($, length, url.includes('/modpack/')))
}

// 修改处理帖子内容的函数
function processPost($: cheerio.CheerioAPI, totalPreviewLength: number) {
  const contentSections: string[] = []

  const title = $('.postname h5').text().trim()
  if (title) contentSections.push(title)

  let totalLength = 0

  $('div.text p').each((_, pElem) => {
    if (totalLength >= totalPreviewLength) return false

    const $pElem = $(pElem)
    let text = $pElem.clone()
      .find('script, .figure')
      .remove()
      .end()
      .text()
      .trim()
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '') // 清理不可见字符
      .replace(/\s+/g, ' ')
      .replace(/\[(\w+)\]/g, '')

    // 继续处理段落和图片
    totalLength = processTextAndImages($pElem, text, contentSections, totalPreviewLength, totalLength)
  })

  return { sections: contentSections, links: [] }
}

// 处理物品内容
function processItem($: cheerio.CheerioAPI, totalPreviewLength: number) {
  const contentSections: string[] = []

  // 处理标题和图标
  const itemName = $('.itemname .name h5').text().trim()
  if (itemName) contentSections.push(itemName)

  processImages($('.item-info-table img').first(), contentSections)
  processContent($, '.item-content.common-text', contentSections, totalPreviewLength)

  return { sections: contentSections, links: [] }
}

// 辅助函数 - 处理相关链接
function processRelatedLinks($: cheerio.CheerioAPI): string[] {
  const links: string[] = []
  const $linkList = $('.common-link-frame .list ul li')
  if (!$linkList.length) return links

  const linkMap = new Map<string, { url: string; name: string }>()

  $linkList.each((_, item) => {
    const $item = $(item)
    const $link = $item.find('a')
    const $name = $item.find('.name')

    const url = $link.attr('href')
    const rawType = $link.attr('data-original-title') || $name.text().trim()

    // 提取类型和名称
    const [type, customName] = rawType.split(':').map(s => s.trim())
    const name = customName || type

    if (url && type) {
      let processedUrl = url.startsWith('//link.mcmod.cn/target/')
        ? atob(url.split('target/')[1])
        : url.startsWith('//') ? `https:${url}` : url

      // 只保存每个类型的第一个链接及其名称
      if (!linkMap.has(type)) {
        linkMap.set(type, {
          url: processedUrl,
          name
        })
      }
    }
  })

  if (linkMap.size) {
    links.push(...Array.from(linkMap.entries())
      .map(([type, { url, name }]) => `${type}${name !== type ? ` (${name})` : ''}: ${url}`))
  }

  return links
}

// 处理模组/整合包内容
function processMod($: cheerio.CheerioAPI, totalPreviewLength: number, isModpack: boolean) {
  const contentSections: string[] = []
  try {
    // 基本信息处理
    processModBasicInfo($, contentSections, isModpack)

    // 处理版本信息
    processModVersionInfo($, contentSections, isModpack)

    // 处理简介内容
    const $content = $('.common-text')
    if ($content.length) {
      contentSections.push('\n')
      // 提取简介第一段作为主要内容
      const firstParagraph = $content.find('p').first().text().trim()
      if (firstParagraph) {
        contentSections.push(cleanText(firstParagraph))
      }
    }

    return {
      sections: contentSections,
      links: processRelatedLinks($)
    }
  } catch (error) {
    console.error('处理MOD内容时出错:', error)
    return {
      sections: ['内容处理出错,请直接访问原页面查看'],
      links: []
    }
  }
}

// 添加文本清理函数
function cleanText(text: string): string {
  if (!text) return ''

  return text
    // 移除特殊控制字符
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
    // 移除零宽字符
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 移除重复空白
    .replace(/\s+/g, ' ')
    // 移除html注释
    .replace(/<!--[\s\S]*?-->/g, '')
    // 移除特定标记
    .replace(/\[(\w+)\]/g, '')
    .trim()
}

// 修改文本和图片处理函数
function processTextAndImages($elem: cheerio.Cheerio<any>, text: string, sections: string[], maxLength: number, currentLength: number): number {
  try {
    if (!text) return currentLength

    text = cleanText(text)
    if (!text) return currentLength

    const title = $elem.find('.common-text-title')
    if (title.length) {
      const titleText = cleanText(title.text())
      if (titleText) {
        text = `『${titleText}』${text.replace(titleText, '')}`
      }
    }

    if (text) {
      const remainingChars = maxLength - currentLength
      if (text.length > remainingChars) {
        text = text.slice(0, remainingChars) + '...'
        sections.push(text)
        return maxLength
      } else {
        sections.push(text)
        currentLength += text.length
      }
    }

    // ...existing image processing code...

    return currentLength
  } catch (error) {
    console.error('处理文本时出错:', error)
    return currentLength
  }
}

// 辅助函数 - 处理通用内容区域
function processContent($: cheerio.CheerioAPI, selector: string, sections: string[], maxLength: number) {
  const contentArea = $(selector)
  if (!contentArea.length) return

  let totalLength = 0
  let skipNext = false

  contentArea.children().each((_, elem) => {
    const $elem = $(elem)
    if (totalLength >= maxLength) return false

    if (skipNext) {
      skipNext = false
      return
    }

    // 处理图片
    const figure = $elem.find('.figure')
    if (figure.length) {
      processImages(figure.find('img'), sections)
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
            const remainingChars = maxLength - totalLength
            if (combinedText.length > remainingChars) {
              combinedText = combinedText.slice(0, remainingChars) + '......'
              totalLength = maxLength
            } else {
              totalLength += combinedText.length
            }
            sections.push(combinedText)
            skipNext = true
          } else {
            sections.push(`『${title.text().trim()}』`)
          }
          return
        } else {
          sections.push(`『${title.text().trim()}』`)
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
        const remainingChars = maxLength - totalLength
        if (text.length > remainingChars) {
          text = text.slice(0, remainingChars) + '......'
          totalLength = maxLength
        } else {
          totalLength += text.length
        }
        sections.push(text)
      }
    }
  })
}

// 辅助函数 - 处理图片
function processImages($img: cheerio.Cheerio<any>, sections: string[]) {
  if (!$img.length) return

  let imgSrc = $img.attr('data-src') || $img.attr('src')
  if (imgSrc && !imgSrc.startsWith('http')) {
    imgSrc = `https:${imgSrc}`
  }
  if (imgSrc) {
    sections.push(h.image(imgSrc).toString())
  }
}

// 辅助函数 - 处理模组基本信息
function processModBasicInfo($: cheerio.CheerioAPI, sections: string[], isModpack: boolean) {
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
  sections.push(formattedTitle)

  // 提取封面图片
  const coverImage = $('.class-cover-image img').first()
  if (coverImage.length) {
    processImages(coverImage, sections)
  }

  // 提取信息
  $('.class-info-left .col-lg-4').each((_, elem) => {
    const text = $(elem).text().trim()
      .replace(/\s+/g, ' ')
      .replace(/：/g, ':')

    if (isModpack) {
      // 整合包只保留特定信息
      if (text.includes('整合包类型') ||
          text.includes('运作方式') ||
          text.includes('打包方式')) {
        sections.push(text)
      }
    } else {
      // mod只保留运行环境信息
      if (text.includes('运行环境')) {
        sections.push(text)
      }
    }
  })
}

// 辅助函数 - 处理版本信息
function processModVersionInfo($: cheerio.CheerioAPI, sections: string[], isModpack: boolean) {
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
      sections.push('支持版本:')
      sections.push(versionInfo.join(', '))
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
      sections.push('支持版本:')
      sections.push(versionTexts.join('\n'))
    }
  }
}

// 修改内容格式化函数
function formatContentSections(result: { sections: string[]; links: string[] }, url: string) {
  try {
    if (!result || !Array.isArray(result.sections)) {
      throw new Error('内容格式无效')
    }

    const { sections, links } = result
    const parts = {
      header: [] as string[],
      desc: [] as string[],
    }

    let currentSection: keyof typeof parts = 'header'
    let descStarted = false

    for (const section of sections) {
      if (!section) continue

      const trimmed = cleanText(section.toString())
      if (!trimmed) continue

      if (trimmed.startsWith('『')) {
        descStarted = true
        currentSection = 'desc'
      }

      parts[currentSection].push(trimmed)
    }

    const output: string[] = []

    if (parts.header.length > 0) {
      output.push(...parts.header)
    }

    if (Array.isArray(links) && links.length > 0) {
      if (output.length > 0) output.push('')
      output.push('相关链接:')
      output.push(...links.map(link => cleanText(link)))
    }

    if (parts.desc.length > 0) {
      if (output.length > 0) output.push('')
      output.push('简介:')
      output.push(...parts.desc)
    }

    if (output.length > 0) output.push('')
    output.push(`详细内容: ${url}`)

    const finalContent = output.join('\n').replace(/\n{3,}/g, '\n\n').trim()

    // 最终检查
    if (!finalContent) {
      return `无法获取详细内容，请直接访问：${url}`
    }

    return finalContent

  } catch (error) {
    console.error('格式化内容时出错:', error)
    return `获取内容失败，请直接访问：${url}`
  }
}
