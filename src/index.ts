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
  }
  versionCheck: {
    enabled: boolean
    groups: string[]
    interval: number
  }
  server: {
    host: string
    port: number
  }
}

export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    defaultLanguage: Schema.union(Object.keys(LANGUAGES) as LangCode[])
      .default('zh')
      .description('默认的 Wiki 浏览语言'),
    pageTimeout: Schema.number()
      .default(30)
      .description('获取页面超时时间（秒）'),
    searchResultLimit: Schema.number()
      .default(10)
      .description('搜索结果最大显示数量'),
  }).description('Wiki 相关设置'),

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

  /**
   * 根据语言代码获取对应的 Wiki 域名和语言变体
   * @param {LangCode} lang - 语言代码
   * @returns {{domain: string, variant: string}} 域名和语言变体信息
   */
  const getWikiDomain = (lang: LangCode) => {
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

  /**
   * 构建 Wiki URL
   * @param {string} title - 页面标题
   * @param {string} domain - Wiki 域名
   * @param {string} [variant] - 语言变体
   * @param {boolean} [includeVariant=false] - 是否在 URL 中包含语言变体参数
   * @returns {string} 完整的 Wiki URL
   */
  const buildWikiUrl = (title: string, domain: string, variant?: string, includeVariant = false) => {
    const baseUrl = `https://${domain}/w/${encodeURIComponent(title)}`
    return includeVariant && variant ? `${baseUrl}?variant=${variant}` : baseUrl
  }

  /**
   * 使用 Puppeteer 获取 Wiki 页面截图
   * @param {string} url - 页面 URL
   * @param {LangCode} lang - 语言代码
   * @returns {Promise<{image: Buffer, height: number, truncated: boolean}>} 截图结果
   * @throws {Error} 当页面加载失败时抛出错误
   */
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
            width: auto !important;
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
        height: dimensions.height,
        truncated: dimensions.height > 3840
      }

    } finally {
      await context.close()
    }
  }

  /**
   * 搜索 Wiki 页面
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<Array<{title: string, url: string}>>} 搜索结果数组
   * @throws {Error} 当搜索失败时抛出错误
   */
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

  /**
   * 获取 Wiki 页面内容
   * @param {string} pageUrl - 页面 URL
   * @param {LangCode} lang - 语言代码
   * @returns {Promise<{title: string, content: string, url: string}>} 页面内容
   * @throws {Error} 当获取内容失败时抛出错误
   */
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
    const paragraphs = $('#mw-content-text p')
      .filter((_, el) => {
        const text = $(el).text().trim()
        return text && !text.startsWith('[')
      })
      .map((_, el) => $(el).text().trim())
      .get()

    if (!paragraphs.length) {
      const cleanUrl = pageUrl.split('?')[0]
      return { title, content: `${title}：本页面目前没有内容。`, url: cleanUrl }
    }

    const content = paragraphs.join('\n').slice(0, 600)
    const cleanUrl = pageUrl.split('?')[0]
    return {
      title,
      content: content.length >= 600 ? content + '...' : content,
      url: cleanUrl
    }
  }

  /**
   * 统一处理 Wiki 页面请求
   * @param {string} keyword - 搜索关键词
   * @param {string} userId - 用户 ID
   * @param {'text' | 'image' | 'search'} [mode='text'] - 处理模式
   * @returns {Promise<string | object>} 处理结果
   * @throws {Error} 当处理失败时抛出错误
   */
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
            const { image, truncated } = await captureWiki(pageUrl, lang)
            return { image, truncated }
          }
        }
      }

      const { title, content, url } = await getWikiContent(pageUrl, lang)
      return `『${title}』${content}\n详细内容：${url}`

    } catch (error) {
      const action = {
        'image': '页面截图',
        'search': '搜索条目',
        'text': '内容查询'
      }[mode]
      throw new Error(`${action}失败：${error.message}`)
    }
  }

  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`使用方法：\nmcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图\nmcwiki.lang <语言> - 设置显示语言`)

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
        }\n回复序号查看内容（添加 -i 获取截图）`

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
          await session.send(`正在获取页面截图...\n完整内容：${displayUrl}`)
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
        await session.send(`正在获取页面截图...\n完整内容：${result.url}`)

        // 然后获取并发送图片
        const { image } = await result.getImage()
        return h.image(image, 'image/png')
      } catch (error) {
        return error.message
      }
    })

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
        return `获取版本信息失败：${error.message}`
      }
    })

  /**
   * 检查 Minecraft 版本更新
   * @returns {Promise<void>}
   */
  async function checkVersion() {
    const retryCount = 3
    const retryDelay = 30000

    for (let i = 0; i < retryCount; i++) {
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
                try {
                  await bot.sendMessage(gid, msg)
                } catch (e) {
                  ctx.logger('mc-tools').warn(`发送更新通知失败 (群:${gid}):`, e)
                }
              }
            }
          }
          versions[type] = ver.id
        }
        break
      } catch (error) {
        if (i === retryCount - 1) {
          ctx.logger('mc-tools').warn('版本检查失败（已达最大重试次数）：', error)
        } else {
          ctx.logger('mc-tools').warn(`版本检查失败（将在${retryDelay/1000}秒后重试）：`, error)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
        }
      }
    }
  }

  if (config.versionCheck.enabled && config.versionCheck.groups.length) {
    checkVersion()
    setInterval(checkVersion, config.versionCheck.interval * 60 * 1000)
  }

  // Server status
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
        lines.push(displayAddr)

        // 处理MOTD（增强类型检查）
        let motd = '无描述信息'
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
          motd = extractText(client.description).trim() || '无描述信息'
          motd = motd.replace(/§[0-9a-fk-or]/g, '')
          lines.push(motd)
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
            lines.push('当前在线：' + playerList.join(', '))
            if (playerList.length < players.online) {
              lines.push(`（仅显示 ${playerList.length}/${players.online} 名玩家）`)
            }
          }
        }

        return lines.join('\n')
      } catch (error) {
        if (!error) return '未知错误'

        if (error.code === 'ECONNREFUSED') {
          return `无法连接到服务器 ${host}:${port} (连接被拒绝)`
        }
        if (error.code === 'ETIMEDOUT') {
          return `连接服务器超时 ${host}:${port}`
        }
        if (error.code === 'ENOTFOUND') {
          return `无法解析服务器地址 ${host}`
        }
        return `查询失败: ${error.message || '未知错误'}`
      }
    })

  // 添加协议版本到游戏版本的映射函数
  /**
   * 根据协议版本获取对应的游戏版本
   * @param {number} protocol - 协议版本号
   * @returns {string} 对应的游戏版本
   */
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
