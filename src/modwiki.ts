import axios from 'axios'
import * as cheerio from 'cheerio'
import { h } from 'koishi'
import { formatErrorMessage } from './utils'

export interface ModwikiConfig {
  searchDescLength: number
  totalPreviewLength: number
  searchTimeout: number
  searchResultLimit: number
}

// 统一的结果类型
interface SearchResult {
  title: string
  url: string
  desc: string
  type: 'mod' | 'modpack' | 'item' | 'post' | 'unknown'
}

// 统一的内容处理器
async function processContent(url: string, config: ModwikiConfig) {
  const $ = await fetchAndParse(url)
  const sections: Array<string | { url: string, toString(): string }> = []

  const type = getContentType(url)
  const contentHandler = contentHandlers[type]

  if (contentHandler) {
    await contentHandler($, sections, config.totalPreviewLength)
  } else {
    throw new Error('不支持的内容类型')
  }

  return formatContentSections(sections, url)
}

// 基础功能函数
async function fetchAndParse(url: string) {
  const response = await axios.get(url)
  return cheerio.load(response.data)
}

function getContentType(url: string): SearchResult['type'] {
  if (url.includes('/modpack/')) return 'modpack'
  if (url.includes('/class/')) return 'mod'
  if (url.includes('/item/')) return 'item'
  if (url.includes('/post/')) return 'post'
  return 'unknown'
}

function processCommonText($: cheerio.CheerioAPI, selector: string, sections: string[], maxLength: number) {
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
      addImageToSections(img, sections)
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

function addContentToSections(sections: string[], text: string, currentLength: number, maxLength: number): number {
  const remainingLength = maxLength - currentLength
  if (text.length > remainingLength) {
    sections.push(text.slice(0, remainingLength) + '...')
    return maxLength
  } else {
    sections.push(text)
    return currentLength + text.length
  }
}

function addImageToSections($img: cheerio.Cheerio<any>, sections: string[]) {
  const imgSrc = $img.attr('data-src') || $img.attr('src')
  if (imgSrc) {
    // 修复图片URL问题,处理 i.mcmod.cn 域名
    const fullSrc = imgSrc.startsWith('//i.mcmod.cn') ?
                   `https:${imgSrc.replace(/@\d+x\d+\.jpg$/, '')}` : // 移除尺寸后缀
                   imgSrc.startsWith('//') ? `https:${imgSrc}` :
                   imgSrc.startsWith('/') ? `https://www.mcmod.cn${imgSrc}` :
                   imgSrc.startsWith('http') ? imgSrc :
                   `https:${imgSrc}`

    sections.push(h.image(fullSrc).toString())
  }
}

// 各类型内容处理器
const contentHandlers = {
  mod: async ($: cheerio.CheerioAPI, sections: string[], maxLength: number) => {
    const basicInfo = extractModBasicInfo($)
    sections.push(basicInfo.title)
    if (basicInfo.cover) sections.push(basicInfo.cover.toString())

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

  modpack: async ($: cheerio.CheerioAPI, sections: string[], maxLength: number) => {
    const basicInfo = extractModBasicInfo($)
    sections.push(basicInfo.title)
    if (basicInfo.cover) sections.push(basicInfo.cover.toString())

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

  item: async ($: cheerio.CheerioAPI, sections: string[], maxLength: number) => {
    const itemName = $('.itemname .name h5').text().trim()
    if (itemName) sections.push(itemName)

    addImageToSections($('.item-info-table img').first(), sections)
    sections.push('\n物品介绍:')
    processCommonText($, '.item-content.common-text', sections, maxLength)
  },

  post: async ($: cheerio.CheerioAPI, sections: string[], maxLength: number) => {
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
  const coverSrc = coverImage.attr('data-src') || coverImage.attr('src')
  const cover = coverImage.length && coverSrc ?
    h.image(coverSrc.startsWith('//i.mcmod.cn') ?
         `https:${coverSrc.replace(/@\d+x\d+\.jpg$/, '')}` : // 移除尺寸后缀
         coverSrc.startsWith('//') ? `https:${coverSrc}` :
         coverSrc.startsWith('/') ? `https://www.mcmod.cn${coverSrc}` :
         coverSrc.startsWith('http') ? coverSrc :
         `https:${coverSrc}`
    ) : null

  return { title: formattedTitle, cover }
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
function formatContentSections(sections: Array<string | Element | { url: string; toString(): string }>, url: string) {
  return sections
    .filter(Boolean)
    .map(section => section)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + `\n\n详细内容: ${url}`
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
    throw new Error(`搜索失败：${formatErrorMessage(error)}`)
  }
}

function extractSearchDesc($item: cheerio.Cheerio<any>, maxLength: number): string {
  if (maxLength <= 0) return ''

  const desc = $item.find('.body').text().trim()
    .replace(/\[(\w+)[^\]]*\]/g, '')
    .replace(/data:image\/\w+;base64,[a-zA-Z0-9+/=]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return desc.length > maxLength ? desc.slice(0, maxLength) + '...' : desc
}

// 添加截图处理函数
async function captureModPage(page: any, url: string) {
  await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })

  await page.goto(url, {
    waitUntil: 'networkidle0',
    timeout: 30000
  })

  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = `
      body { margin: 0; background: white; }
      .header, .navbar, .footer, .sidebar, .fixedtool, #feedback, .ad-wrap { display: none !important; }
      .wrapper { padding: 20px; max-width: 1000px; margin: 0 auto; }
      .class-cover-image img, .item-info-table img { max-width: 300px; height: auto; display: block; margin: 1em auto; }
      img { max-width: 100%; height: auto; }
      img[src^="//"] { visibility: hidden; }
      img[src^="/"] { visibility: hidden; }
    `
    document.head.appendChild(style)

    document.querySelectorAll('.header, .navbar, .footer, .sidebar, .fixedtool, #feedback, .ad-wrap')
      .forEach(el => el.remove())
  })

  const wrapper = await page.$('.wrapper')
  if (!wrapper) throw new Error('无法获取页面内容')

  const screenshot = await wrapper.screenshot({
    type: 'png',
    omitBackground: true
  })

  return screenshot
}

// 修改导出函数添加截图支持
export async function processMCMODContent(
  url: string,
  config: ModwikiConfig,
  ctx?: any,
  mode: 'text' | 'image' = 'text'
) {
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

    return await processContent(url, config)
  } catch (error) {
    const type = {
      mod: 'MOD',
      modpack: '整合包',
      item: '物品',
      post: '教程'
    }[getContentType(url)] || '内容'

    throw new Error(`获取${type}信息失败：${formatErrorMessage(error)}`)
  }
}
