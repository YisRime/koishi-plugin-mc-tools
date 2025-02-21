import { h } from 'koishi'
import axios from 'axios';
import * as cheerio from 'cheerio'

// 1. 常量和类型定义
export const LANGUAGES = {
  'zh': '中文（简体）',
  'zh-hk': '中文（繁體）',
  'en': 'English',
  'ja': '日本語',
  'ko': '한국어',
  'fr': 'Français',
  'de': 'Deutsch',
  'es': 'Español',
  'it': 'Italiano',
  'pt': 'Português',
  'ru': 'Русский',
  'pl': 'Polski',
  'nl': 'Nederlands',
  'tr': 'Türkçe'
} as const

export type LangCode = keyof typeof LANGUAGES

export interface MinecraftToolsConfig {
  wiki: {
    defaultLanguage: LangCode
    pageTimeout: number
    searchResultLimit: number
    minSectionLength: number
    sectionPreviewLength: number
    totalPreviewLength: number
    searchDescLength: number
  }
  server: {
    host: string
    port: number
  }
  versionCheck: {
    enabled: boolean
    groups: string[]
    interval: number
  }
}

// 2. 基础工具函数
export function formatErrorMessage(error: any): string {
  if (!error) return '未知错误'
  const message = error.message || String(error)

  const networkErrors = {
    ECONNREFUSED: '无法连接服务器',
    ETIMEDOUT: '连接超时',
    ENOTFOUND: '找不到服务器',
    ECONNRESET: '连接被重置',
  }

  if (error.code in networkErrors) {
    return networkErrors[error.code]
  }

  return message
}

export function parseServerMessage(obj: any): string {
  if (!obj) return ''
  if (typeof obj === 'string') return obj
  if (typeof obj === 'object') {
    if ('text' in obj) return obj.text
    if ('extra' in obj && Array.isArray(obj.extra)) {
      return obj.extra.map(parseServerMessage).join('')
    }
    if (Array.isArray(obj)) {
      return obj.map(parseServerMessage).join('')
    }
  }
  return ''
}

export function isSearchAllowed(lastSearchTime: number): number | false {
  const now = Date.now()
  const SEARCH_COOLDOWN = 1000
  if (now - lastSearchTime < SEARCH_COOLDOWN) return false
  return now
}

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

// 4. 服务器相关函数
export function getMinecraftVersionFromProtocol(protocol: number): string {
  const protocolMap: Record<number, string> = {
    764: '1.20.1',
    762: '1.19.4',
    756: '1.18.2',
    753: '1.17.1',
    752: '1.16.5',
    736: '1.15.2',
    498: '1.14.4',
    404: '1.13.2',
    340: '1.12.2',
    316: '1.11.2',
    210: '1.10.2',
    110: '1.9.4',
    47: '1.8.9'
  }

  if (protocol in protocolMap) {
    return protocolMap[protocol]
  }

  const protocols = Object.keys(protocolMap).map(Number).sort((a, b) => b - a)

  for (let i = 0; i < protocols.length; i++) {
    const currentProtocol = protocols[i]
    const nextProtocol = protocols[i + 1]

    if (protocol > currentProtocol) {
      return `~${protocolMap[currentProtocol]}+`
    } else if (nextProtocol && protocol > nextProtocol && protocol < currentProtocol) {
      return `~${protocolMap[nextProtocol]}-${protocolMap[currentProtocol]}`
    }
  }

  if (protocol < 47) {
    return '~1.8.9'
  }

  return `未知版本(协议:${protocol})`
}

export function parseServerPlayerStats(players: any) {
  if (!players) return { online: 0, max: 0 }
  return {
    online: players.online ?? 0,
    max: players.max ?? 0,
    sample: players.sample ?? []
  }
}

export function parseServerConfiguration(client: any) {
  const settings: string[] = []
  if ('onlineMode' in client) {
    settings.push(client.onlineMode ? '正版验证' : '离线模式')
  }
  if ('enforceSecureChat' in client) {
    settings.push(client.enforceSecureChat ? '开启签名' : '无需签名')
  }
  if ('whitelist' in client) {
    settings.push(client.whitelist ? '有白名单' : '无白名单')
  }
  return settings
}

export async function checkMinecraftUpdate(versions: { snapshot: string, release: string }, ctx: any, config: MinecraftToolsConfig) {
  try {
    const { data } = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json', {
      timeout: 10000
    })
    const latest = data.versions[0]
    const release = data.versions.find(v => v.type === 'release')

    if (!latest || !release) {
      throw new Error('无效的版本数据')
    }

    for (const [type, ver] of [['snapshot', latest], ['release', release]]) {
      if (versions[type] && ver.id !== versions[type]) {
        const msg = `发现MC更新：${ver.id} (${type})\n发布时间：${new Date(ver.releaseTime).toLocaleString('zh-CN')}`
        for (const gid of config.versionCheck.groups) {
          for (const bot of ctx.bots) {
            await bot.sendMessage(gid, msg).catch(e => {
              ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
            })
          }
        }
      }
      versions[type] = ver.id
    }
  } catch (error) {
    ctx.logger('mc-tools').error(`版本检查失败: ${formatErrorMessage(error)}`)
  }
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
