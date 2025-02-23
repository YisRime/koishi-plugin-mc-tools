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

// 统一的结果类型
interface SearchResult {
  title: string
  url: string
  desc: string
  type: 'mod' | 'modpack' | 'item' | 'post' | 'unknown'
}

// 修改sections类型定义，将图片URL作为特殊类型存储
type ContentSection = string | { type: 'image', url: string }

// 统一的内容处理器
async function processContent(url: string, config: ModwikiConfig) {
  const $ = await fetchAndParse(url)
  const sections: ContentSection[] = []

  const type = getContentType(url)
  const contentHandler = contentHandlers[type]

  if (contentHandler) {
    await contentHandler($, sections, config.totalPreviewLength)
  } else {
    throw new Error('不支持的内容类型')
  }

  return formatContentSections(sections, url)
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

  $(selector).children().each((_, elem) => {
    if (totalLength >= maxLength) return false

    const $elem = $(elem)
    if ($elem.is('p, ol, ul')) {
      const text = processTextContent($elem)
      if (text) {
        totalLength = addContentToSections(sections, text, totalLength, maxLength)
      }
    }

    const img = $elem.find('img').first()
    if (img.length) {
      const imageUrl = processImage(img)
      if (imageUrl) sections.push({ type: 'image', url: imageUrl })
    }
  })
}

function processTextContent($elem: cheerio.Cheerio<any>): string {
  const title = $elem.find('.common-text-title')
  const text = $elem.clone()
    .find('script,.figure')
    .remove()
    .end()
    .text()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\[(\w+)\]/g, '')

  return title.length ? `『${title.text().trim()}』${text}` : text
}

function addContentToSections(sections: ContentSection[], text: string, currentLength: number, maxLength: number): number {
  const remainingLength = maxLength - currentLength
  if (text.length > remainingLength) {
    sections.push(text.slice(0, remainingLength) + '...')
    return maxLength
  } else {
    sections.push(text)
    return currentLength + text.length
  }
}

// 通用的图片处理函数
function processImage($img: cheerio.Cheerio<any>): string {
  const imgSrc = $img.attr('data-src') || $img.attr('src')
  if (!imgSrc) return ''

  return imgSrc.startsWith('//i.mcmod.cn') ? `https:${imgSrc.replace(/@\d+x\d+\.jpg$/, '')}` : // 移除尺寸后缀
         imgSrc.startsWith('//') ? `https:${imgSrc}` :
         imgSrc.startsWith('/') ? `https://www.mcmod.cn${imgSrc}` :
         imgSrc.startsWith('http') ? imgSrc :
         `https:${imgSrc}`
}

// 各类型内容处理器
const contentHandlers = {
  mod: async ($: cheerio.CheerioAPI, sections: ContentSection[], maxLength: number) => {
    const basicInfo = extractModBasicInfo($)
    sections.push(basicInfo.title)
    if (basicInfo.cover) sections.push(basicInfo.cover)

    // 运行环境信息
    $('.class-info-left .col-lg-4').each((_, elem) => {
      const text = $(elem).text().trim().replace(/\s+/g, ' ')
      if (text.includes('运行环境')) sections.push(text)
    })

    // 版本信息
    const versions = extractModVersions($)
    if (versions.length) {
      sections.push('支持版本:')
      sections.push(versions.join('\n'))
    }

    processCommonText($, '.common-text', sections, maxLength)
  },

  modpack: async ($: cheerio.CheerioAPI, sections: ContentSection[], maxLength: number) => {
    const basicInfo = extractModBasicInfo($)
    sections.push(basicInfo.title)
    if (basicInfo.cover) sections.push(basicInfo.cover)

    // 整合包信息
    $('.class-info-left .col-lg-4').each((_, elem) => {
      const text = $(elem).text().trim().replace(/\s+/g, ' ')
      if (text.match(/整合包类型|运作方式|打包方式/)) sections.push(text)
    })

    // 支持版本
    const versions = $('.mcver ul li')
      .map((_, elem) => $(elem).text().trim())
      .get()
      .filter(v => v && !v.includes('Forge:') && v.match(/^\d/))

    if (versions.length) {
      sections.push('支持版本:')
      sections.push(versions.join(', '))
    }

    processCommonText($, '.common-text', sections, maxLength)
  },

  item: async ($: cheerio.CheerioAPI, sections: ContentSection[], maxLength: number) => {
    const itemName = $('.itemname .name h5').text().trim()
    if (itemName) sections.push(itemName)

    const itemImage = $('.item-info-table img').first()
    if (itemImage.length) {
      const imageUrl = processImage(itemImage)
      if (imageUrl) sections.push({ type: 'image', url: imageUrl })
    }

    sections.push('\n物品介绍:')
    processCommonText($, '.item-content.common-text', sections, maxLength)
  },

  post: async ($: cheerio.CheerioAPI, sections: ContentSection[], maxLength: number) => {
    const title = $('.postname h5').text().trim()
    if (title) sections.push(title)
    processCommonText($, 'div.text', sections, maxLength)
  }
}

function extractModBasicInfo($: cheerio.CheerioAPI) {
  const shortName = $('.short-name').first().text().trim()
  const title = $('.class-title h3').first().text().trim()
  const enTitle = $('.class-title h4').first().text().trim()

  const statusLabels = $('.class-official-group .class-status, .class-official-group .class-source')
    .map((_, elem) => $(elem).text().trim())
    .get()

  const formattedTitle = `${shortName} ${enTitle} | ${title}${statusLabels.length ? ` (${statusLabels.join(' | ')})` : ''}`

  const coverImage = $('.class-cover-image img').first()
  const coverUrl = coverImage.length ? processImage(coverImage) : null

  return {
    title: formattedTitle,
    cover: coverUrl ? { type: 'image' as const, url: coverUrl } : null
  }
}

function extractModVersions($: cheerio.CheerioAPI) {
  const versionInfo: Record<string, string[]> = {}

  $('.mcver ul').each((_, elem) => {
    const loader = $(elem).find('li:first').text().trim().split(':')[0].trim()
    const versions = $(elem).find('a')
      .map((_, ver) => $(ver).text().trim())
      .get()
      .filter(v => v.match(/^\d/))

    if (versions.length) versionInfo[loader] = versions
  })

  return Object.entries(versionInfo)
    .filter(([_, vers]) => vers.length > 0)
    .map(([loader, vers]) => `${loader}: ${vers.join(', ')}`)
}

// 格式化最终输出
function formatContentSections(sections: ContentSection[], url: string) {
  return {
    sections: sections.filter(Boolean),
    url
  }
}

// 统一的导出接口
export async function searchMCMOD(keyword: string, config: ModwikiConfig): Promise<SearchResult[]> {
  try {
    const $ = await fetchAndParse(`https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`)
    return $('.result-item').map((_, item) => {
      const $item = $(item)
      const titleEl = $item.find('.head a').last()
      const url = titleEl.attr('href') || ''

      return {
        title: titleEl.text().trim(),
        url: url.startsWith('http') ? url : `https://www.mcmod.cn${url}`,
        desc: extractSearchDesc($item, config.searchDescLength),
        type: getContentType(url)
      }
    }).get().filter(r => r.title && r.url)
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
    if (mode === 'image') {
      if (!ctx?.puppeteer) {
        throw new Error('截图功能不可用：未找到 puppeteer 服务')
      }

      return {
        url,
        async getImage() {
          const context = await ctx.puppeteer.browser.createBrowserContext()
          const page = await context.newPage()
          try {
            const image = await captureModPage(page, url)
            return { image }
          } finally {
            await context.close()
          }
        }
      }
    }

    const result = await processContent(url, config)
    const elements = result.sections.map(section => {
      if (typeof section === 'string') return section
      if (section.type === 'image') return h.image(section.url)
      return ''
    })

    return h(() => [
      ...elements,
      `\n\n详细内容: ${result.url}`
    ])

  } catch (error) {
    throw new Error(`获取帖子内容失败: ${error.message}`)
  }
}

// 添加截图功能
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

    // 注入优化样式
    await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = `
        body { margin: 0; background: white; }
        .col-lg-12.center {
          margin: 0 auto;
          padding: 20px;
          box-sizing: border-box;
          width: 100%;
          max-width: 1000px;
        }
        img { max-width: 100%; height: auto; }
      `
      document.head.appendChild(style)
    })

    // 清理无用元素
    await page.evaluate(() => {
      const elementsToRemove = [
        '#header', '#footer', '.comment-area',
        'script', 'iframe', '#back-to-top'
      ]
      elementsToRemove.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => el.remove())
      })
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
