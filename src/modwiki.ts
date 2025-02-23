import axios from 'axios'
import * as cheerio from 'cheerio'
import { h } from 'koishi'

export interface ModwikiConfig {
  searchDescLength: number
  totalPreviewLength: number
  searchTimeout: number
  searchResultLimit: number
  pageTimeout: number  // 新增
}

// 统一的搜索结果格式
interface SearchResult {
  title: string
  url: string
  desc: string
  type: string
}

// 基础搜索功能
export async function searchMCMOD(keyword: string, config: ModwikiConfig) {
  const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`
  const response = await axios.get(searchUrl)
  const $ = cheerio.load(response.data)

  const searchResults: SearchResult[] = []

  $('.result-item').each((_, item) => {
    const $item = $(item)
    const titleEl = $item.find('.head a').last()
    const title = titleEl.text().trim()
    const url = titleEl.attr('href') || ''

    const type = url.includes('/modpack/') ? '整合包' :
                url.includes('/class/') ? 'MOD' :
                url.includes('/item/') ? '物品' :
                url.includes('/post/') ? '教程' : '未知'

    let desc = config.searchDescLength > 0 ?
      $item.find('.body').text().trim()
        .replace(/\[(\w+)[^\]]*\]/g, '')
        .replace(/data:image\/\w+;base64,[a-zA-Z0-9+/=]+/g, '')
        .replace(/\s+/g, ' ')
        .trim() : ''

    if (desc && desc.length > config.searchDescLength) {
      desc = desc.slice(0, config.searchDescLength) + '...'
    }

    if (title && url) {
      searchResults.push({
        title,
        url: url.startsWith('http') ? url : `https://www.mcmod.cn${url}`,
        desc: desc || '',
        type
      })
    }
  })

  return searchResults
}

// 处理各种类型内容的统一接口
export async function processMCMODContent(url: string, config: ModwikiConfig) {
  try {
    const response = await axios.get(url)
    const $ = cheerio.load(response.data)
    const contentSections: string[] = []

    if (url.includes('/post/')) {
      return processPost($, config.totalPreviewLength)
    } else if (url.includes('/item/')) {
      return processItem($, config.totalPreviewLength)
    } else {
      const isModpack = url.includes('/modpack/')
      return processMod($, config.totalPreviewLength, isModpack)
    }
  } catch (error) {
    throw new Error(`内容处理失败: ${error.message}`)
  }
}

// 处理帖子内容
function processPost($: cheerio.CheerioAPI, totalPreviewLength: number) {
  const contentSections: string[] = []

  // 提取标题
  const title = $('.postname h5').text().trim()
  if (title) contentSections.push(title)

  // 处理内容
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
      .replace(/\s+/g, ' ')
      .replace(/\[(\w+)\]/g, '')

    // 处理段落和图片
    processTextAndImages($pElem, text, contentSections, totalPreviewLength, totalLength)
  })

  return contentSections
}

// 处理物品内容
function processItem($: cheerio.CheerioAPI, totalPreviewLength: number) {
  const contentSections: string[] = []

  // 处理标题和图标
  const itemName = $('.itemname .name h5').text().trim()
  if (itemName) contentSections.push(itemName)

  processImages($('.item-info-table img').first(), contentSections)

  contentSections.push('\n物品介绍:')
  processContent($, '.item-content.common-text', contentSections, totalPreviewLength)

  return contentSections
}

// 处理模组/整合包内容
function processMod($: cheerio.CheerioAPI, totalPreviewLength: number, isModpack: boolean) {
  const contentSections: string[] = []

  // 处理基本信息
  processModBasicInfo($, contentSections, isModpack)

  // 处理版本信息
  processModVersionInfo($, contentSections, isModpack)

  // 处理描述内容
  processContent($, '.common-text', contentSections, totalPreviewLength)

  return contentSections
}

// 辅助函数 - 处理文本和图片
function processTextAndImages($elem: cheerio.Cheerio<any>, text: string, sections: string[], maxLength: number, currentLength: number) {
  if (!text) return currentLength

  const title = $elem.find('.common-text-title')
  if (title.length) {
    text = `『${title.text().trim()}』${text.replace(title.text().trim(), '')}`
  }

  if (text) {
    const remainingChars = maxLength - currentLength
    if (text.length > remainingChars) {
      text = text.slice(0, remainingChars) + '......'
      sections.push(text)
      return maxLength
    } else {
      sections.push(text)
      currentLength += text.length
    }
  }

  const figure = $elem.find('.figure')
  if (figure.length) {
    const img = figure.find('img')
    if (img.length) {
      let imgSrc = img.attr('data-src') || img.attr('src')
      if (imgSrc && !imgSrc.startsWith('http')) {
        imgSrc = `https:${imgSrc}`
      }
      if (imgSrc) {
        sections.push(h.image(imgSrc).toString())
      }
    }
  }

  return currentLength
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
      .replace(/：/g, ': ')

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

// 修改处理函数的返回值格式化
function formatContentSections(sections: string[], url: string) {
  return sections
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + `\n\n详细内容: ${url}`
}

// 修改导出函数
export async function processModSearchResult(url: string, config: ModwikiConfig) {
  try {
    const content = await processMCMODContent(url, config)
    return formatContentSections(content, url)
  } catch (error) {
    throw new Error(`获取内容失败: ${error.message}`)
  }
}

export async function processItemSearchResult(url: string, config: ModwikiConfig) {
  try {
    const content = await processMCMODContent(url, config)
    return formatContentSections(content, url)
  } catch (error) {
    throw new Error(`获取物品内容失败: ${error.message}`)
  }
}

export async function processPostSearchResult(url: string, config: ModwikiConfig) {
  try {
    const content = await processMCMODContent(url, config)
    return formatContentSections(content, url)
  } catch (error) {
    throw new Error(`获取帖子内容失败: ${error.message}`)
  }
}

// 修改截图功能
export async function captureMCMODPageScreenshot(page: any, url: string, config: ModwikiConfig) {
  try {
    // 设置初始视口
    await page.setViewport({
      width: 1000,
      height: 800,
      deviceScaleFactor: 1
    })

    // 页面加载与重试机制
    let retries = 3
    while (retries > 0) {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: config.pageTimeout * 1000
        })
        break
      } catch (err) {
        retries--
        if (retries === 0) throw err
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    // 等待内容加载
    await page.waitForSelector('.col-lg-12.center', {
      timeout: config.pageTimeout * 1000,
      visible: true
    })

    // 注入优化样式并隐藏不需要的元素
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        .col-lg-12.center {
          margin: 0 auto;
          padding: 20px;
          box-sizing: border-box;
          width: 100%;
          max-width: 1000px;
          background: white;
        }
        img { max-width: 100%; height: auto; }
        header, footer, .header-container, .common-background,
        .common-nav, .common-menu-page, .common-comment-block,
        .comment-ad {
          display: none !important;
        }
      `
      document.head.appendChild(style)

      // 隐藏其他不需要的元素
      document.querySelectorAll('header, footer, .header-container, .common-background, .common-nav, .common-menu-page, .common-comment-block, .comment-ad')
        .forEach(el => el.remove())
    })

    // 获取内容区域尺寸
    const dimensions = await page.evaluate(() => {
      const content = document.querySelector('.col-lg-12.center')
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

    // 调整视口并截图
    await page.setViewport({
      width: dimensions.width,
      height: dimensions.height,
      deviceScaleFactor: 1
    })

    // 等待内容完全渲染
    await new Promise(resolve => setTimeout(resolve, 500))

    // 获取目标元素的位置和尺寸
    const clipData = await page.evaluate(() => {
      const element = document.querySelector('.col-lg-12.center')
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      }
    })

    if (!clipData) {
      throw new Error('无法获取目标元素位置')
    }

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      omitBackground: true,
      clip: clipData
    })

    return {
      image: screenshot,
      height: clipData.height
    }
  } catch (error) {
    throw new Error(`截图失败: ${error.message}`)
  }
}

// 添加处理截图请求的函数
export async function processMCMODScreenshot(url: string, config: ModwikiConfig, ctx: any) {
  const context = await ctx.puppeteer.browser.createBrowserContext()
  const page = await context.newPage()
  try {
    const { image } = await captureMCMODPageScreenshot(page, url, config)
    return { image }
  } finally {
    await context.close()
  }
}
