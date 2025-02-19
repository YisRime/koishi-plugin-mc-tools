import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'
import { MCInfo } from './mcinfo'

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
    pageLoadTimeout: number
    searchResultLimit: number
    userInputTimeout: number
    screenshotHeight: number
  }
  version: {
    check: {
      enabled: boolean
      groupIds: string[]
      intervalMs: number
    }
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
    pageLoadTimeout: Schema.number()
      .default(8000)
      .description('页面加载超时时间（毫秒）'),
    searchResultLimit: Schema.number()
      .default(10)
      .description('搜索结果最大显示数量'),
    userInputTimeout: Schema.number()
      .default(10000)
      .description('用户输入等待超时时间（毫秒）'),
    screenshotHeight: Schema.number()
      .default(4000)
      .description('Wiki 页面截图最大高度（像素）')
  }).description('Wiki 相关设置'),

  version: Schema.object({
    check: Schema.object({
      enabled: Schema.boolean()
        .default(false)
        .description('是否启用版本更新检查'),
      groupIds: Schema.array(Schema.string())
        .default([])
        .description('接收版本更新通知的群组 ID'),
      intervalMs: Schema.number()
        .default(3600000)
        .description('版本检查间隔时间（毫秒）')
    }).description('版本更新检查设置')
  }).description('版本相关设置'),

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

  // 修改 getWikiDomain 函数，添加 variantLang 参数
  const getWikiDomain = (lang: LangCode) => {
    const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
    const variantLang = lang === 'zh' ? 'zh-cn' : lang
    return { domain, variantLang }
  }

  async function captureWiki(url: string, lang: LangCode) {
    const context = await ctx.puppeteer.browser.createBrowserContext()
    const page = await context.newPage()

    try {
      // 设置语言相关的请求头
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${lang},${lang}-*;q=0.9`
      })

      const { variantLang } = getWikiDomain(lang)
      const finalUrl = `${url}${url.includes('?') ? '&' : '?'}variant=${variantLang}`
      await page.goto(finalUrl, { waitUntil: 'networkidle0', timeout: config.wiki.pageLoadTimeout })

      // 等待主要内容加载
      await page.waitForSelector('.mw-parser-output', { timeout: 5000 })

      // 清理页面，隐藏干扰元素
      await page.evaluate(() => {
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
            if (el instanceof HTMLElement) {
              el.style.display = 'none'
            }
          })
        })

        const content = document.querySelector('.mw-parser-output')
        if (content instanceof HTMLElement) {
          content.style.padding = '20px'
          content.style.margin = '0 auto'
          content.style.maxWidth = '1200px'
        }
      })

      // 获取主要内容区域并确保元素存在
      const content = await page.$('.mw-parser-output')
      if (!content) {
        throw new Error('找不到页面主要内容')
      }

      // 获取内容区域的尺寸
      const boundingBox = await content.boundingBox()
      if (!boundingBox) {
        throw new Error('无法获取内容区域尺寸')
      }

      const {x, y, width, height} = boundingBox

      // 截取内容区域
      const screenshot = await content.screenshot({
        type: 'png',
        clip: {
          x,
          y,
          width,
          height: Math.min(height, config.wiki.screenshotHeight)
        }
      })

      return {
        image: screenshot,
        height,
        truncated: height > config.wiki.screenshotHeight
      }
    } catch (error) {
      throw new Error(`Wiki 页面截图失败: ${error.message}`)
    } finally {
      await context.close()
    }
  }

  async function searchWiki(keyword: string, lang: LangCode) {
    const { domain, variantLang } = getWikiDomain(lang)
    const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.wiki.searchResultLimit}&variant=${variantLang}`
    const [_, titles, descriptions, urls] = await axios.get(searchUrl).then(res => res.data)
    return titles.map((title, i) => ({ title, description: descriptions[i], url: urls[i] }))
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
  ctx.command('mcwiki.lang <lang>', '设置 Wiki 浏览语言')
    .action(({ session }, lang: LangCode) => {
      if (!lang) return `当前浏览语言：${LANGUAGES[userLangs.get(session.userId) || config.wiki.defaultLanguage]}\n可选语言：\n${Object.entries(LANGUAGES).map(([c, n]) => `${c} - ${n}`).join('\n')}`
      if (!(lang in LANGUAGES)) return '暂不支持该语言，请选择其他语言代码'
      userLangs.set(session.userId, lang)
      return `Wiki 浏览语言已设置为：${LANGUAGES[lang]}`
    })

  ctx.command('mcwiki.search <keyword:text>', '搜索 Minecraft Wiki 内容')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const lang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const results = await searchWiki(keyword, lang)

        if (!results.length) return '未找到相关结果'

        let msg = '搜索结果：\n' + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.description || '暂无描述'}`).join('\n')
        msg += '\n- 输入数字(1-' + results.length + ')：查看文字版内容\n- 输入数字-i：获取页面截图\n- 等待超时或输入其他内容：取消操作'

        await session.send(msg)
        const response = await session.prompt(config.wiki.userInputTimeout)
        if (!response) return '搜索超时，已取消'

        // 解析用户输入
        const [input, flag] = response.split('-')
        const num = parseInt(input)

        if (isNaN(num) || num < 1 || num > results.length) {
          return '无效序号，请重新搜索'
        }

        const result = results[num - 1]
        const pageUrl = `https://${getWikiDomain(lang).domain}/w/${encodeURIComponent(result.title)}`

        // 如果有 -i 标记，返回截图
        if (flag?.trim() === 'i') {
          try {
            const { image, height } = await captureWiki(pageUrl, lang)
            if (height > config.wiki.screenshotHeight) {
              await session.send(`页面内容较长，已截取前 ${config.wiki.screenshotHeight} 像素。完整页面: ${pageUrl}`)
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

  // 修改相关命令处理函数
  ctx.command('mcwiki.shot <keyword:text>', '获取 Wiki 页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要截图的页面标题或关键词'

      try {
        const lang = userLangs.get(session.userId) || config.wiki.defaultLanguage
        const { domain } = getWikiDomain(lang)
        const pageUrl = `https://${domain}/w/${encodeURIComponent(keyword)}`

        const { image, truncated } = await captureWiki(pageUrl, lang)

        if (truncated) {
          await session.send(`页面内容较长，已截取前 ${config.wiki.screenshotHeight} 像素。完整页面: ${pageUrl}`)
        }

        return h.image(image, 'image/png')
      } catch (error) {
        return `截图失败: ${error.message}`
      }
    })

  // 添加主 Wiki 命令
  ctx.command('mcwiki <keyword:text>', 'Minecraft Wiki 查询')
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
          config.version.check.groupIds.forEach(gid => ctx.bots.forEach(bot => bot.sendMessage(gid, msg)))
        }
        versions[type] = ver.id
      }
    } catch (error) {
      ctx.logger('mc-tools').warn('版本检查失败：', error)
    }
  }

  if (config.version.check.enabled && config.version.check.groupIds.length) {
    checkVersion()
    setInterval(checkVersion, config.version.check.intervalMs)
  }

  // Server status
  ctx.command('mcinfo [server]', '查询 MC 服务器状态')
    .action(async (_, server) => {
      const mcInfo = new MCInfo()
      try {
        let host: string
        let port: number

        if (!server) {
          // 使用默认配置
          host = config.server.host
          port = config.server.port
        } else {
          // 解析输入的服务器地址
          if (server.includes(':')) {
            const [inputHost, inputPort] = server.split(':')
            host = inputHost
            port = parseInt(inputPort)
            if (isNaN(port)) {
              return '端口格式错误，请输入有效的数字'
            }
          } else {
            host = server
            port = 25565 // 默认端口
          }
        }

        return await mcInfo.queryServer(host, port)
      } catch (error) {
        return `查询失败: ${error.message}`
      }
    })
}
