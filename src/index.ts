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
    timeout: number
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
    timeout: Schema.number()
      .default(10000)
      .description('超时时间（毫秒）'),
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

export function apply(ctx: Context, config: MinecraftToolsConfig) {
  const userLangs = new Map<string, LangCode>()
  const versions = { snapshot: '', release: '' }

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

  // 新增：构建 Wiki URL 的辅助函数
  const buildWikiUrl = (title: string, domain: string, variant?: string, includeVariant = false) => {
    const baseUrl = `https://${domain}/w/${encodeURIComponent(title)}`
    return includeVariant && variant ? `${baseUrl}?variant=${variant}` : baseUrl
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
        timeout: config.wiki.timeout
      })

      // 等待主要内容加载完成
      await page.waitForSelector('#bodyContent', { timeout: config.wiki.timeout })

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
          '.mw-indicators'    // 右上角指示器
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
        // 如果内容过长则返回 true
        truncated: dimensions.height > 3840
      }

    } finally {
      await context.close()
    }
  }

  async function searchWiki(keyword: string) {
    const { domain } = getWikiDomain('zh')  // 使用简体中文进行搜索
    try {
      const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.wiki.searchResultLimit}&variant=zh-cn`
      const { data } = await axios.get(searchUrl, {
        params: { variant: 'zh-cn' },  // 确保使用简体中文
        timeout: config.wiki.timeout
      })

      const [_, titles, urls] = data
      if (!titles?.length) return []
      return titles.map((title, i) => ({ title, url: urls[i] }))
    } catch (error) {
      ctx.logger('mc-tools').warn(`Wiki搜索失败: ${error.message}`)
      throw new Error('搜索失败，请稍后重试')
    }
  }

  // 修改 getWikiContent 函数，添加语言参数支持
  async function getWikiContent(pageUrl: string, lang: LangCode) {
    const { variant } = getWikiDomain(lang)
    // 确保请求时使用带 variant 的 URL
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
      // 移除链接中的variant参数
      const cleanUrl = pageUrl.split('?')[0]
      return { title, content: '本页面目前没有内容。', url: cleanUrl }
    }

    const content = paragraphs.join('\n').slice(0, 600)
    // 移除链接中的variant参数
    const cleanUrl = pageUrl.split('?')[0]
    return {
      title,
      content: content.length >= 600 ? content + '...' : content,
      url: cleanUrl
    }
  }

  // Wiki commands
  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`使用方法：\nmcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图`)
  // 统一的 Wiki 页面处理函数
  async function handleWikiPage(keyword: string, userId: string, mode: 'text' | 'image' | 'search' = 'text') {
    if (!keyword) return '请输入要查询的内容关键词'

    try {
      const lang = userLangs.get(userId) || config.wiki.defaultLanguage
      const results = await searchWiki(keyword)

      if (!results.length) return '未找到相关结果'

      const { domain, variant } = getWikiDomain(lang)

      // 搜索模式特殊处理
      if (mode === 'search') {
        return {
          results,
          domain,
          lang
        }
      }

      const result = results[0]
      const pageUrl = buildWikiUrl(result.title, domain, variant, true) // 内部使用时包含 variant

      // 根据模式返回不同内容
      if (mode === 'image') {
        const { image, truncated } = await captureWiki(pageUrl, lang)
        const displayUrl = buildWikiUrl(result.title, domain) // 展示时不包含 variant
        return {
          image,
          truncated,
          pageUrl: displayUrl
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
        const response = await session.prompt(config.wiki.timeout)

        if (!response) return '操作超时'

        const [input, flag] = response.split('-')
        const index = parseInt(input) - 1

        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        const result = results[index]
        // 使用 buildWikiUrl 构建内部使用的 URL（带variant）和展示用的 URL（不带variant）
        const pageUrl = buildWikiUrl(result.title, domain, variant, true)

        if (flag?.trim() === 'i') {
          const { image, truncated } = await captureWiki(pageUrl, lang)
          if (truncated) {
            // 展示用的 URL 不带 variant
            const displayUrl = buildWikiUrl(result.title, domain)
            await session.send(`完整内容: ${displayUrl}`)
          }
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

        const { image, truncated, pageUrl } = result
        if (truncated) {
          await session.send(`完整内容：${pageUrl}`)
        }
        return h.image(image, 'image/png')
      } catch (error) {
        return error.message
      }
    })

  // Version check
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

  async function checkVersion() {
    const retryCount = 3
    const retryDelay = 30000 // 30秒

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

        // 显示服务器图标
        if ('favicon' in client && client.favicon) {
          lines.push(h.image(client.favicon).toString())
        }

        // 仅在不带参数且端口不是25565时显示端口
        if (!server) {
          lines.push(port === 25565 ? host : `${host}:${port}`)
        }

        // 处理MOTD
        let motd = '无描述信息'
        if ('description' in client && client.description) {
          if (typeof client.description === 'string') {
            motd = client.description
          } else if (typeof client.description === 'object') {
            motd = client.description.text ||
                   (Array.isArray(client.description.extra)
                    ? client.description.extra
                        .map(e => typeof e === 'string' ? e : (e.text || ''))
                        .join('')
                    : '')
          }
        }
        motd = motd.replace(/§[0-9a-fk-or]/g, '').trim() || '无描述信息'

        // 获取版本信息和支持范围
        let versionInfo = ''
        if (client.version) {
          const currentVersion = typeof client.version === 'string'
            ? client.version
            : client.version.name

          let minVersion = ''
          if (typeof client.version === 'object' && client.version.protocol) {
            minVersion = getVersionFromProtocol(client.version.protocol)
          }

          versionInfo = minVersion && minVersion !== currentVersion
            ? `${currentVersion}(${minVersion}+)`
            : currentVersion
        } else {
          versionInfo = '未知版本'
        }

        // 状态信息行
        const playerCount = 'players' in client && client.players
          ? `${client.players.online}/${client.players.max}`
          : '0/0'

        lines.push(`${versionInfo} | ${playerCount} | ${pingTime}ms`)

        // 服务器设置信息
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

        // 如果有在线玩家则单独显示
        if ('players' in client && client.players?.sample?.length > 0) {
          lines.push('当前在线：' + client.players.sample.map(p => p.name).join(', '))
        }

        return lines.join('\n')
      } catch (error) {
        if (error.code === 'ECONNREFUSED') {
          // 错误信息中也遵循同样的规则
          const addr = port === 25565 ? host : `${host}:${port}`
          return `无法连接到服务器 ${addr}`
        } else if (error.code === 'ETIMEDOUT') {
          return '服务器连接超时'
        }
        return `查询失败: ${error.message}`
      }
    })

  // 添加协议版本到游戏版本的映射函数
  function getVersionFromProtocol(protocol: number): string {
    const protocolMap: Record<number, string> = {
      764: '1.20.1',
      763: '1.20',
      762: '1.19.4',
      761: '1.19.4-pre1',
      760: '1.19.3',
      759: '1.19.2',
      758: '1.19.1',
      757: '1.19',
      756: '1.18.2',
      755: '1.18.1',
      754: '1.18',
      753: '1.17.1',
      752: '1.16.5',
      751: '1.16.4',
      750: '1.16.3',
      749: '1.16.2',
      748: '1.16.1',
      747: '1.16',
      736: '1.15.2',
      735: '1.15.1',
      734: '1.15',
      498: '1.14.4',
      497: '1.14.3',
      496: '1.14.2',
      495: '1.14.1',
      494: '1.14',
      404: '1.13.2',
      403: '1.13.1',
      402: '1.13',
      340: '1.12.2',
      339: '1.12.1',
      338: '1.12',
      316: '1.11.2',
      315: '1.11',
      210: '1.10.2',
      110: '1.9.4',
      109: '1.9.2',
      108: '1.9.1',
      107: '1.9',
      47: '1.8.9',
      46: '1.8.8',
      45: '1.8.7',
      44: '1.8.6',
      43: '1.8.5',
      42: '1.8.4',
      41: '1.8.3',
      40: '1.8.2',
      39: '1.8.1',
      38: '1.8',
      // 更老的版本一般用不到，就不添加了
    }
    return protocolMap[protocol] || `协议版本${protocol}`
  }
}
