import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'
import * as mc from 'minecraft-protocol'

export const name = 'mc-tools'
export const inject = {required: ['puppeteer']}

const LANGUAGES = {
  'zh': '简体中文',
  'en': 'English',
  'es': 'Español',
  'fr': 'Français',
  'de': 'Deutsch',
  'it': 'Italiano',
  'ja': '日本語',
  'ko': '한국어',
  'pl': 'Polski',
  'pt': 'Português',
  'ru': 'Русский',
  'th': 'ไทย',
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

  // 修改 getWikiDomain 函数，更新 zh 语言的变体代码
  const getWikiDomain = (lang: LangCode) => {
    const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
    const variantLang = lang === 'zh' ? 'zh-Hans-CN' : lang
    return { domain, variantLang }
  }

  async function captureWiki(url: string, lang: LangCode) {
    const context = await ctx.puppeteer.browser.createBrowserContext()
    const page = await context.newPage()

    try {
      await page.setViewport({
        width: 1000,  // 更改为wiki的默认宽度
        height: 800,
        deviceScaleFactor: 1,
      })

      // 设置请求头
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`,
        'Cache-Control': 'no-cache'
      })

      const { variantLang } = getWikiDomain(lang)
      const finalUrl = `${url}${url.includes('?') ? '&' : '?'}variant=${variantLang}&uselang=${lang}&setlang=${lang}`

      await page.goto(finalUrl, {
        waitUntil: 'networkidle0',
        timeout: config.wiki.timeout
      })

      // 等待主要内容加载
      await page.waitForSelector('#bodyContent', { timeout: config.wiki.timeout })
      await page.waitForSelector('#mw-content-text', { timeout: config.wiki.timeout })

      // 注入自定义样式并清理页面
      await page.evaluate(() => {
        const style = document.createElement('style')
        style.textContent = `
          body { margin: 0; background: white; }
          #content {
            margin: 0 !important;
            padding: 20px !important;
            border: none !重要;
          }
          #mw-page-base, #mw-head-base, #mw-panel,
          #mw-navigation, #footer, #siteNotice,
          .mw-indicators, .mw-editsection {
            display: none !important;
          }
          #bodyContent {
            margin: 0 !important;
            width: auto !important;
          }
          .mw-parser-output {
            max-width: 960px !important;
            margin: 0 auto !important;
          }
          .notaninfobox {
            float: none !important;
            margin: 1em auto !important;
            width: 100% !important;
            max-width: 300px !important;
          }
          table, img {
            max-width: 100% !important;
            height: auto !important;
          }
        `
        document.head.appendChild(style)

        // 移除不需要的元素
        const hideSelectors = [
          '.mw-indicators',
          '.mw-editsection',
          '#toc',
          '.navbox',
          '.catlinks',
          '.printfooter',
          '#siteNotice',
          '.noprint',
          '.mw-jump-link',
          '.mw-redirectedfrom'
        ]
        hideSelectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => {
            el.remove()
          })
        })
      })

      // 获取内容区域尺寸
      const dimensions = await page.evaluate(() => {
        const content = document.querySelector('#content')
        if (!content) return null

        // 确保所有图片加载完成
        const images = Array.from(content.querySelectorAll('img'))
        images.forEach(img => {
          if (!img.complete) {
            img.style.height = '0'
            img.style.width = 'auto'
          }
        })

        const rect = content.getBoundingClientRect()
        return {
          x: Math.floor(rect.x),
          y: Math.floor(rect.y),
          width: Math.min(1000, Math.floor(rect.width)),
          height: Math.floor(rect.height)
        }
      })

      // 截图
      const screenshot = await page.screenshot({
        clip: {
          x: dimensions.x,
          y: dimensions.y,
          width: dimensions.width,
          height: Math.min(dimensions.height, 3840)
        },
        type: 'png',
        omitBackground: true
      })

      return {
        image: screenshot,
        height: dimensions.height,
        truncated: dimensions.height > 3840
      }

    } catch (error) {
      throw new Error(`${error.message}`)
    } finally {
      await context.close()
    }
  }

  async function searchWiki(keyword: string, lang: LangCode) {
    const { domain, variantLang } = getWikiDomain(lang)
    const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.wiki.searchResultLimit}&variant=${variantLang}&uselang=${lang}&setlang=${lang}`

    const { data } = await axios.get(searchUrl, {
      headers: {
        'Accept-Language': `${lang},${lang}-*;q=0.9,en;q=0.8`,
        'Cookie': `language=${lang}; hl=${lang}; uselang=${lang}`
      }
    })

    const [_, titles, , urls] = data
    return titles.map((title, i) => ({ title, url: urls[i] }))
  }

  // 添加获取Wiki内容的辅助函数
  async function getWikiContent(pageUrl: string) {
    const response = await axios.get(pageUrl)
    const $ = cheerio.load(response.data)

    const paragraphs = $('#mw-content-text p')
      .filter((_, el) => $(el).text().trim() !== '')
      .map((_, el) => $(el).text().trim())
      .get()
      .join('\n\n')

    if (!paragraphs) {
      return '本页面目前没有内容。'
    }

    const content = paragraphs.length > 600
      ? paragraphs.slice(0, 600) + '...'
      : paragraphs

    return content
  }

  // Wiki commands
  ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage('输入 mcwiki <关键词> 直接查询内容\n使用子命令获取更多功能')
    .example('mcwiki 末影龙 - 查询末影龙的信息')
    .subcommand('.search <keyword:text>', '搜索 Wiki 页面')
    .subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .subcommand('.lang <lang>', '设置 Wiki 浏览语言')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的内容'
      try {
        const lang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const results = await searchWiki(keyword, lang)

        if (!results.length) return '未找到相关结果'

        // 直接获取第一个搜索结果的内容
        const result = results[0]
        const { domain } = getWikiDomain(lang)
        const pageUrl = `https://${domain}/w/${encodeURIComponent(result.title)}`

        const content = await getWikiContent(pageUrl)
        return `${content}\n链接：${pageUrl}`

      } catch (error) {
        return `查询失败: ${error.message}`
      }
    })

  // 注册子指令的处理函数
  ctx.command('mcwiki/search')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'
      try {
        const lang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const results = await searchWiki(keyword, lang)

        if (!results.length) return '未找到相关结果'

        let msg = '搜索结果如下：\n' + results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
        msg += '\n输入序号：查看文字内容\n输入（序号-i）：获取页面截图'

        await session.send(msg)
        const response = await session.prompt(config.wiki.timeout)
        if (!response) return '搜索超时，已取消'

        // 解析用户输入
        const [input, flag] = response.split('-')
        const num = parseInt(input)

        if (isNaN(num) || num < 1 || num > results.length) {
          return '序号无效'
        }

        const result = results[num - 1]
        const pageUrl = `https://${getWikiDomain(lang).domain}/w/${encodeURIComponent(result.title)}`

        // 如果有 -i 标记，返回截图
        if (flag?.trim() === 'i') {
          try {
            const { image, height } = await captureWiki(pageUrl, lang)
            if (height > 3840) {
              await session.send(`页面内容过长，完整页面: ${pageUrl}`)
            }
            return h.image(image, 'image/png')
          } catch (error) {
            return `截图失败: ${error.message}`
          }
        }

        // 否则返回文字内容
        const content = await getWikiContent(pageUrl)
        return `${content}\n链接：${pageUrl}`

      } catch (error) {
        return `搜索失败: ${error.message}`
      }
    })

  ctx.command('mcwiki/shot')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要截图的页面标题或关键词'
      try {
        const lang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const { domain } = getWikiDomain(lang)
        const pageUrl = `https://${domain}/w/${encodeURIComponent(keyword)}`

        const { image, truncated } = await captureWiki(pageUrl, lang)

        if (truncated) {
          await session.send(`页面内容过长，完整页面: ${pageUrl}`)
        }

        return h.image(image, 'image/png')
      } catch (error) {
        return `截图失败: ${error.message}`
      }
    })

  ctx.command('mcwiki/lang')
    .action(({ session }, lang: LangCode) => {
      if (!lang) return `当前浏览语言：${LANGUAGES[userLangs.get(session.userId) || config.wiki.defaultLanguage]}\n可选语言：\n${Object.entries(LANGUAGES).map(([c, n]) => `${c} - ${n}`).join('\n')}`
      if (!(lang in LANGUAGES)) return '暂不支持该语言，请选择其他语言代码'
      userLangs.set(session.userId, lang)
      return `Wiki 浏览语言已设置为：${LANGUAGES[lang]}`
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
    try {
      const { data } = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json')
      const latest = data.versions[0]
      const release = data.versions.find(v => v.type === 'release')

      for (const [type, ver] of [['snapshot', latest], ['release', release]]) {
        if (versions[type] && ver.id !== versions[type]) {
          const msg = `发现MC更新：${ver.id} (${type})\n发布于：${new Date(ver.releaseTime).toLocaleString()}`
          config.versionCheck.groups.forEach(gid => ctx.bots.forEach(bot => bot.sendMessage(gid, msg)))
        }
        versions[type] = ver.id
      }
    } catch (error) {
      ctx.logger('mc-tools').warn('版本检查失败：', error)
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

        let response = ''

        // 仅在不带参数时显示服务器地址
        if (!server) {
          response = `${host}:${port}\n`
        }

        // 处理MOTD
        if ('description' in client && client.description) {
          const motd = typeof client.description === 'string'
            ? client.description
            : typeof client.description === 'object'
              ? client.description.text ||
                (client.description.extra?.map(e =>
                  typeof e === 'string' ? e : e.text
                ).join(''))
              : '无描述信息'
          response += `${motd.replace(/§[0-9a-fk-or]/g, '')}\n`
        }

        // 处理版本信息和延迟
        if (client.version) {
          const versionName = typeof client.version === 'string' ? client.version : client.version.name
          response += `${versionName} (${pingTime}ms)\n`
        }

        // 处理玩家信息
        if ('players' in client && client.players) {
          response += `在线：${client.players.online}/${client.players.max}`
          if (client.players.sample?.length > 0) {
            response += `, ${client.players.sample.map(p => p.name).join(', ')}`
          }
        }

        return response.trim()
      } catch (error) {
        if (error.code === 'ECONNREFUSED') {
          return `无法连接到服务器 ${host}:${port}`
        } else if (error.code === 'ETIMEDOUT') {
          return '服务器连接超时'
        }
        return `查询失败: ${error.message}`
      }
    })
}
