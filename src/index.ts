import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'
import * as mc from 'minecraft-protocol'

export const name = 'mc-tools'
export const inject = {required: ['puppeteer']}

// 扩展语言支持
const LANGUAGES = {
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

type LangCode = keyof typeof LANGUAGES

export interface MinecraftToolsConfig {
  wiki: {
    defaultLanguage: LangCode
    pageTimeout: number
    searchResultLimit: number
    minSectionLength: number
    sectionPreviewLength: number
    totalPreviewLength: number
    mcmodApiBase: string
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

export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    defaultLanguage: Schema.union(Object.keys(LANGUAGES) as LangCode[])
      .default('zh')
      .description('默认的 Wiki 浏览语言'),
    mcmodApiBase: Schema.string()
      .description('MCMOD API 地址')
      .default('https://mcmod-api.vercel.app'),
    pageTimeout: Schema.number()
      .default(30)
      .description('获取页面超时时间（秒）'),
    searchResultLimit: Schema.number()
      .default(10)
      .description('搜索结果最大显示数量'),
    minSectionLength: Schema.number()
      .default(12)
      .description('段落最小字数'),
    sectionPreviewLength: Schema.number()
      .default(50)
      .description('非首段预览字数'),
    totalPreviewLength: Schema.number()
      .default(500)
      .description('总预览字数限制'),
  }).description('Wiki 与模组百科相关设置'),

  versionCheck: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('是否启用版本更新检查'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('接收版本更新通知的群组 ID'),
    interval: Schema.number()
      .default(60)
      .description('版本检查间隔时间（分钟）')
  }).description('版本更新检查设置'),

  server: Schema.object({
    host: Schema.string()
      .description('默认服务器地址')
      .default('localhost'),
    port: Schema.number()
      .description('默认服务器端口')
      .default(25565)
  }).description('默认的 Minecraft 服务器配置')
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, config: MinecraftToolsConfig) {
  const userLangs = new Map<string, LangCode>()
  const versions = { snapshot: '', release: '' }
  let lastSearchTime = 0
  const SEARCH_COOLDOWN = 1000

  // 通用工具函数
  function checkSearchCooldown(): boolean {
    const now = Date.now()
    if (now - lastSearchTime < SEARCH_COOLDOWN) return false
    lastSearchTime = now
    return true
  }

  function handleError(error: any): string {
    if (!error) return '未知错误'
    const message = error.message || String(error)

    // 网络错误映射
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

  // Wiki 功能相关代码
  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`mcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图\nmcwiki.lang <语言> - 设置显示语言`)

  mcwiki.subcommand('.lang [language:string]', '设置Wiki显示语言')
    .action(({ session }, language) => {
      if (!language) {
        const currentLang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const langList = Object.entries(LANGUAGES)
          .map(([code, name]) => `${code}: ${name}${code === currentLang ? ' (当前)' : ''}`)
          .join('\n')
        return `当前支持的语言：\n${langList}`
      }

      if (!(language in LANGUAGES)) {
        return `不支持的语言代码。支持的语言代码：${Object.keys(LANGUAGES).join(', ')}`
      }

      userLangs.set(session.userId, language as LangCode)
      return `已将 Wiki 显示语言设置为${LANGUAGES[language as LangCode]}`
    })

  mcwiki.action(async ({ session }, keyword) => {
    try {
      const result = await handleWikiPage(keyword, session.userId)
      return result
    } catch (error) {
      return error.message
    }
  })

  mcwiki.subcommand('.search <keyword:text>', '搜索 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        const searchResult = await handleWikiPage(keyword, session.userId, 'search') as any
        if (typeof searchResult === 'string') return searchResult

        const { results, domain, lang } = searchResult
        const { variant } = getWikiDomain(lang)

        const msg = `Wiki 搜索结果：\n${
          results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
        }\n请回复序号查看对应内容\n（使用 -i 后缀以获取页面截图）`

        await session.send(msg)
        const response = await session.prompt(10000)

        if (!response) return '操作超时'

        const [input, flag] = response.split('-')
        const index = parseInt(input) - 1

        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        const result = results[index]
        const pageUrl = buildWikiUrl(result.title, domain, variant, true)
        const displayUrl = buildWikiUrl(result.title, domain)

        if (flag?.trim() === 'i') {
          await session.send(`正在获取页面...\n完整内容：${displayUrl}`)
          const { image } = await captureWiki(pageUrl, lang)
          return h.image(image, 'image/png')
        }

        const { title, content, url } = await getWikiContent(pageUrl, lang)
        return `『${title}』${content}\n详细内容：${url}`

      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
      try {
        const result = await handleWikiPage(keyword, session.userId, 'image') as any
        if (typeof result === 'string') return result

        // 先发送URL
        await session.send(`正在获取页面...\n完整内容：${result.url}`)

        // 然后获取并发送图片
        const { image } = await result.getImage()
        return h.image(image, 'image/png')
      } catch (error) {
        return error.message
      }
    })

  async function handleWikiPage(keyword: string, userId: string, mode: 'text' | 'image' | 'search' = 'text') {
    if (!keyword) return '请输入要查询的内容关键词'

    try {
      const lang = userLangs.get(userId) || config.wiki.defaultLanguage
      const results = await searchWiki(keyword)

      if (!results.length) return `${keyword}：本页面目前没有内容。`

      const { domain, variant } = getWikiDomain(lang)

      if (mode === 'search') {
        return {
          results,
          domain,
          lang
        }
      }

      const result = results[0]
      const pageUrl = buildWikiUrl(result.title, domain, variant, true)
      const displayUrl = buildWikiUrl(result.title, domain)

      // 根据模式返回不同内容
      if (mode === 'image') {
        return {
          url: displayUrl,
          async getImage() {
            const { image } = await captureWiki(pageUrl, lang)
            return { image }
          }
        }
      }

      const { title, content, url } = await getWikiContent(pageUrl, lang)
      return `『${title}』${content}\n详细内容：${url}`

    } catch (error) {
      return handleError(error)
    }
  }

  async function searchWiki(keyword: string) {
    const { domain } = getWikiDomain('zh')
    try {
      const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.wiki.searchResultLimit}&variant=zh-cn`
      const { data } = await axios.get(searchUrl, {
        params: { variant: 'zh-cn' },
        timeout: config.wiki.pageTimeout * 1000
      })

      const [_, titles, urls] = data
      if (!titles?.length) return []
      return titles.map((title, i) => ({ title, url: urls[i] }))
    } catch (error) {
      ctx.logger('mc-tools').warn(`Wiki搜索失败: ${error.message}`)
      throw new Error('搜索失败，请稍后重试')
    }
  }

  async function getWikiContent(pageUrl: string, lang: LangCode) {
    const { variant } = getWikiDomain(lang)
    const requestUrl = pageUrl.includes('?') ? pageUrl : `${pageUrl}?variant=${variant}`

    const response = await axios.get(requestUrl, {
      params: {
        uselang: lang,
        setlang: lang
      }
    })
    const $ = cheerio.load(response.data)

    const title = $('#firstHeading').text().trim()

    // 初始化内容存储
    const sections: { title?: string; content: string[] }[] = []
    let currentSection: { title?: string; content: string[] } = { content: [] }

    // 遍历主内容区域
    $('#mw-content-text .mw-parser-output').children().each((_, element) => {
      const el = $(element)

      // 处理标题 (h2, h3, h4)
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
      // 处理段落和列表
      else if (el.is('p, ul, ol')) {
        const text = el.text().trim()
        // 跳过引用、图片说明和空段落
        if (text && !text.startsWith('[') && !text.startsWith('跳转') && !el.hasClass('quote')) {
          // 清理多余空白
          const cleanText = text.replace(/\s+/g, ' ')
          currentSection.content.push(cleanText)
        }
      }
    })

    // 添加最后一个部分(如果内容足够长)
    if (currentSection.content.length) {
      const totalLength = currentSection.content.join(' ').length
      if (totalLength >= config.wiki.minSectionLength) {
        sections.push(currentSection)
      }
    }

    // 如果没有内容
    if (!sections.length) {
      const cleanUrl = pageUrl.split('?')[0]
      return { title, content: `${title}：本页面目前没有内容。`, url: cleanUrl }
    }

    // 构建格式化的内容，对首段不限制字数，后续部分保持原有限制
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

  async function captureWiki(url: string, lang: LangCode) {
    const context = await ctx.puppeteer.browser.createBrowserContext()
    const page = await context.newPage()

    try {
      // 设置更合适的视口宽度以匹配页面设计
      await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`
      })

      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: config.wiki.pageTimeout * 1000
      })

      // 等待主要内容加载完成
      await page.waitForSelector('#bodyContent', { timeout: config.wiki.pageTimeout * 1000 })

      // 注入优化后的样式
      await page.evaluate(() => {
        const style = document.createElement('style')
        style.textContent = `
          body {
            margin: 0;
            background: white;
            font-family: system-ui, -apple-system, sans-serif;
          }
          #content {
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
            width: 1000px;
          }
          .notaninfobox {
            float: none !important;
            margin: 1em auto !important;
            width: auto !重要;
            max-width: 300px;
          }
          .mw-parser-output {
            max-width: 960px;
            margin: 0 auto;
            line-height: 1.6;
          }
          img {
            max-width: 100%;
            height: auto;
          }
          table {
            margin: 1em auto;
            border-collapse: collapse;
          }
          td, th {
            padding: 0.5em;
            border: 1px solid #ccc;
          }
          pre {
            padding: 1em;
            background: #f5f5f5;
            border-radius: 4px;
            overflow-x: auto;
          }
        `
        document.head.appendChild(style)

        // 移除不必要的元素
        const selectors = [
          '.mw-editsection',  // 编辑按钮
          '#mw-navigation',   // 导航菜单
          '#footer',          // 页脚
          '.noprint',         // 不打印的元素
          '#toc',            // 目录
          '.navbox',         // 导航框
          '#siteNotice',     // 网站通知
          '#contentSub',     // 内容子标题
          '.mw-indicators',   // 右上角指示器
          '.sister-wiki',     // 姊妹维基链接
          '.external'         // 外部链接
        ]
        selectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => el.remove())
        })
      })

      // 获取内容区域的尺寸
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

      // 调整视口以适应完整的内容高度
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

    } finally {
      await context.close()
    }
  }

  function getWikiDomain(lang: LangCode) {
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

  function buildWikiUrl(title: string, domain: string, variant?: string, includeVariant = false) {
    const baseUrl = `https://${domain}/w/${encodeURIComponent(title)}`
    return includeVariant && variant ? `${baseUrl}?variant=${variant}` : baseUrl
  }

  // Mod 功能相关代码
  const modwiki = ctx.command('modwiki', 'MCMOD 模组百科查询')
    .usage('modwiki <关键词> 直接查询\nmodwiki.search <关键词> 搜索并选择\nmodwiki.latest 查看最新更新\nmodwiki.test <关键词> 测试API返回\nmodwiki.link <ID> 查看相关链接\nmodwiki.relate <ID> 查看关联模组')

  modwiki.action(async ({ }, keyword) => {
    if (!keyword) return '请输入要查询的模组关键词'
    if (!checkSearchCooldown()) return '搜索太频繁，请稍后再试'

    try {
      const results = await axios.get(`${config.wiki.mcmodApiBase}/s/key=${encodeURIComponent(keyword)}`)
      if (!results.data?.length) return '未找到相关模组'
      return await getModInfo(results.data[0])
    } catch (error) {
      return handleError(error)
    }
  })

  modwiki.subcommand('.search <keyword:text>', '搜索模组')
    .action(async ({ session }, keyword) => {
      if (!checkSearchCooldown()) return '搜索太频繁，请稍后再试'

      try {
        const results = await axios.get(`${config.wiki.mcmodApiBase}/s/key=${encodeURIComponent(keyword)}`)
        if (!results.data?.length) return '未找到相关模组'

        const msg = '搜索结果：\n' + results.data
          .map((r, i) => `${i + 1}. ${r.title}${r.data?.mcmod_id ? ` (ID: ${r.data.mcmod_id})` : ''}`)
          .join('\n') + '\n请回复序号查看详情'

        await session.send(msg)
        const response = await session.prompt(10000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.data.length) {
          return '请输入有效的序号'
        }

        return await getModInfo(results.data[index])
      } catch (error) {
        return handleError(error)
      }
    })

  // 添加此辅助函数用于生成统一的标题行
  function getTitleLine(data: any): string {
    const shortName = data.short_name ? `${data.short_name}` : ''
    const subtitle = data.subtitle || ''
    return `${shortName}${subtitle}${subtitle ? ' | ' : ''}${data.title}`
  }

  modwiki.subcommand('.link <id:number>', '查看模组相关链接')
    .action(async ({ }, id) => {
      if (!checkSearchCooldown()) return '请求太频繁，请稍后再试'

      try {
        const detail = await axios.get(`${config.wiki.mcmodApiBase}/d/class/${id}`)
        const data = detail.data

        if (!data.related_links?.length) {
          return '该模组没有相关链接'
        }

        const lines = [`${getTitleLine(data)} | 相关链接：\n`]
        data.related_links.forEach(link => {
          lines.push(`- ${link.text}: ${link.url}`)
        })

        return lines.join('\n')
      } catch (error) {
        return handleError(error)
      }
    })

  modwiki.subcommand('.relate <id:number>', '查看关联模组')
    .action(async ({ }, id) => {
      if (!checkSearchCooldown()) return '请求太频繁，请稍后再试'

      try {
        const detail = await axios.get(`${config.wiki.mcmodApiBase}/d/class/${id}`)
        const data = detail.data

        if (!data.mod_relations) {
          return '该模组没有关联模组'
        }

        const lines = [`${getTitleLine(data)} | 关联模组：`]

        // 遍历所有版本的关联
        for (const [version, relations] of Object.entries(data.mod_relations)) {
          if (!Array.isArray(relations) || relations.length === 0) continue

          lines.push(`\n${version}：`)
          for (const relation of relations) {
            if (relation.mods?.length) {
              lines.push(`- ${relation.relation_type}`)
              relation.mods.forEach(mod => {
                const modId = mod.link.match(/\/class\/(\d+)\.html/)?.[1] || ''
                lines.push(`  • ${mod.name}${modId ? ` (ID: ${modId})` : ''}`)
              })
            }
          }
        }

        return lines.join('\n')
      } catch (error) {
        return handleError(error)
      }
    })

  modwiki.subcommand('.latest', '查看最新更新的模组')
    .action(async () => {
      if (!checkSearchCooldown()) return '请求太频繁，请稍后再试'

      try {
        const { data } = await axios.get(`${config.wiki.mcmodApiBase}/latest`)
        return data.slice(0, 5).map((mod, i) => {
          const date = new Date(mod.update_time).toLocaleDateString('zh-CN')
          return `${i + 1}. ${mod.title}\n更新时间：${date}\n${mod.description || ''}`
        }).join('\n\n')
      } catch (error) {
        return handleError(error)
      }
    })

  modwiki.subcommand('.test <keyword:text>', '获取搜索结果原始数据')
    .action(async ({ }, keyword) => {
      if (!checkSearchCooldown()) return '搜索太频繁，请稍后再试'

      try {
        const results = await axios.get(`${config.wiki.mcmodApiBase}/s/key=${encodeURIComponent(keyword)}`)
        if (!results.data?.length) return '未找到相关模组'

        // 直接返回搜索结果的原始数据
        return JSON.stringify(results.data, null, 2)
      } catch (error) {
        return handleError(error)
      }
    })

  // 修改 getModInfo 使用相同的 getTitleLine 函数
  async function getModInfo(result: any) {
    if (!result.data?.mcmod_id) {
      return `${result.title}\n${result.description}`
    }

    try {
      const detail = await axios.get(`${config.wiki.mcmodApiBase}/d/class/${result.data.mcmod_id}`)
      const data = detail.data

      const lines = []

      // 添加封面图片显示
      if (data.cover_image) {
        lines.push(h.image(data.cover_image).toString())
      }

      lines.push(getTitleLine(data), '')  // 标题和空行

      if (data.operating_environment) lines.push(`运行环境：${data.operating_environment}`)

      // 版本信息处理 - 合并所有平台的版本
      if (data.supported_versions) {
        const allVersions: string[] = []

        for (const [platform, versions] of Object.entries(data.supported_versions)) {
          if (!Array.isArray(versions) || versions.length === 0) continue

          // 对版本号进行排序（除了"远古版本"这样的特殊标记）
          const sortedVersions = versions.sort((a, b) => {
            if (!/^\d/.test(a) || !/^\d/.test(b)) return 0
            return b.localeCompare(a, undefined, { numeric: true })
          })

          allVersions.push(`${platform}(${sortedVersions.join(', ')})`)
        }

        if (allVersions.length > 0) {
          lines.push(`支持版本：${allVersions.join(' | ')}`)
        }
      } else if (data.supported_versions?.length) {
        // 向后兼容旧的版本格式
        lines.push(`支持版本：${data.supported_versions.join(', ')}`)
      }

      if (result.address) lines.push(`详情页面：${result.address}`)

      return lines.join('\n')
    } catch (error) {
      throw new Error(`获取模组详情失败: ${handleError(error)}`)
    }
  }

  // MC 版本相关代码
  ctx.command('mcver', '获取 Minecraft 最新版本')
    .action(async () => {
      try {
        const response = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json')
        const { versions } = response.data

        const latest = versions[0]
        const latestRelease = versions.find(v => v.type === 'release')

        const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN')

        return `Minecraft 最新版本：\n正式版：${latestRelease.id}（${formatDate(latestRelease.releaseTime)}）\n快照版：${latest.id}（${formatDate(latest.releaseTime)}）`
      } catch (error) {
        return handleError(error)
      }
    })

  // 版本更新检查
  async function checkVersion() {
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
      ctx.logger('mc-tools').error(`版本检查失败: ${handleError(error)}`)
    }
  }

  if (config.versionCheck.enabled && config.versionCheck.groups.length) {
    checkVersion()
    setInterval(checkVersion, config.versionCheck.interval * 60 * 1000)
  }

  // 服务器状态查询
  ctx.command('mcinfo [server]', '查询 MC 服务器状态')
    .action(async (_, server) => {
      let host = config.server.host
      let port = config.server.port

      if (server) {
        const parts = server.split(':')
        host = parts[0]
        if (parts[1]) {
          const parsedPort = parseInt(parts[1])
          if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            return '端口必须是1-65535之间的数字'
          }
          port = parsedPort
        }
      }

      try {
        const startTime = Date.now()
        const client = await mc.ping({
          host,
          port
        })
        const pingTime = Date.now() - startTime

        const lines: string[] = []

        // 显示服务器图标（检查base64格式）
        if (client && 'favicon' in client && typeof client.favicon === 'string' && client.favicon.startsWith('data:image/png;base64,')) {
          lines.push(h.image(client.favicon).toString())
        }

        // 显示服务器地址
        const displayAddr = port === 25565 ? host : `${host}:${port}`
        if (!server) {
          lines.push(displayAddr)
        }

        // 处理MOTD（增强类型检查）
        if (client && 'description' in client && client.description) {
          const extractText = (obj: any): string => {
            if (!obj) return ''
            if (typeof obj === 'string') return obj
            if (typeof obj === 'object') {
              if ('text' in obj) return obj.text
              if ('extra' in obj && Array.isArray(obj.extra)) {
                return obj.extra.map(extractText).join('')
              }
              if (Array.isArray(obj)) {
                return obj.map(extractText).join('')
              }
            }
            return ''
          }
          const motd = extractText(client.description).trim()
          if (motd) {
            lines.push(motd.replace(/§[0-9a-fk-or]/g, ''))
          }
        }

        // 版本信息（增强类型检查）
        let versionInfo = '未知版本'
        if (client?.version) {
          const currentVersion = typeof client.version === 'object'
            ? (client.version.name || '未知版本')
            : String(client.version)

          const protocol = typeof client.version === 'object'
            ? client.version.protocol
            : null

          versionInfo = protocol
            ? `${currentVersion}(${getVersionFromProtocol(protocol)})`
            : currentVersion
        }

        // 玩家信息（增强类型检查）
        const players = ('players' in client ? client.players : { online: 0, max: 0 })
        const playerCount = `${players.online ?? 0}/${players.max ?? 0}`
        lines.push(`${versionInfo} | ${playerCount} | ${pingTime}ms`)

        // 服务器设置（增强类型检查和默认值）
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
        if (settings.length) {
          lines.push(settings.join(' | '))
        }

        // 在线玩家列表（增强类型检查）
        if (players?.sample?.length > 0) {
          const playerList = players.sample
            .filter(p => p && typeof p.name === 'string')
            .map(p => p.name)
          if (playerList.length > 0) {
            let playerInfo = '当前在线：' + playerList.join(', ')
            if (playerList.length < players.online) {
              playerInfo += `（仅显示 ${playerList.length}/${players.online} 名玩家）`
            }
            lines.push(playerInfo)
          }
        }

        return lines.join('\n')
      } catch (error) {
        return `服务器查询失败: ${handleError(error)}`
      }
    })

  function getVersionFromProtocol(protocol: number): string {
    // 只保留指定的关键版本
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

    // 精确匹配
    if (protocol in protocolMap) {
      return protocolMap[protocol]
    }

    // 按协议号排序，用于版本推测
    const protocols = Object.keys(protocolMap).map(Number).sort((a, b) => b - a)

    // 版本推测逻辑
    for (let i = 0; i < protocols.length; i++) {
      const currentProtocol = protocols[i]
      const nextProtocol = protocols[i + 1]

      if (protocol > currentProtocol) {
        // 高于最新已知版本
        return `~${protocolMap[currentProtocol]}+`
      } else if (nextProtocol && protocol > nextProtocol && protocol < currentProtocol) {
        // 在两个已知版本之间
        return `~${protocolMap[nextProtocol]}-${protocolMap[currentProtocol]}`
      }
    }

    if (protocol < 47) {
      return '~1.8.9'
    }

    return `未知版本(协议:${protocol})`
  }
}
