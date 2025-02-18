import { Context, Schema, segment, Session, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'

export const name = 'mc-tools'

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

export interface Config {
  defaultLang: LangCode
  viewportWidth: number
  viewportHeight: number
  timeout: number
  maxResults: number
  searchTimeout: number
}

export const Config: Schema<Config> = Schema.object({
  defaultLang: Schema.union(['zh', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'th', 'tr']).default('zh')
    .description('默认使用的语言'),
  viewportWidth: Schema.number().default(1280)
    .description('截图视窗宽度'),
  viewportHeight: Schema.number().default(4000)
    .description('截图视窗高度'),
  timeout: Schema.number().default(8000)
    .description('页面加载超时时间(ms)'),
  maxResults: Schema.number().default(10)
    .description('搜索结果最大显示数'),
  searchTimeout: Schema.number().default(10000)
    .description('搜索交互超时时间(ms)')
})

export const inject = {
  required: ['puppeteer']
}

declare module 'koishi' {
  interface Events {
    'mcwiki-search-select'(results: any[], session: Session): void
  }
}

export function apply(ctx: Context, config: Config) {
  // 用户语言设置存储
  const userLangs = new Map<string, LangCode>()

  ctx.command('mcwiki.lang <lang>', '设置Wiki语言')
    .action(async ({ session }, lang: LangCode) => {
      if (!lang) {
        return `当前语言：${LANGUAGES[userLangs.get(session.userId) || config.defaultLang]}\n可用语言：${Object.entries(LANGUAGES).map(([code, name]) => `${code}(${name})`).join(', ')}`
      }
      if (!(lang in LANGUAGES)) {
        return '不支持的语言代码'
      }
      userLangs.set(session.userId, lang)
      return `已将Wiki语言设置为${LANGUAGES[lang]}`
    })

  ctx.command('mcwiki <keyword:text>', '查询Minecraft Wiki')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const lang = userLangs.get(session.userId) || config.defaultLang
        const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
        const searchUrl = `https://${domain}/w/${encodeURIComponent(keyword)}`
        const response = await axios.get(searchUrl)
        const $ = cheerio.load(response.data)

        // 获取主要内容区域的所有段落
        const paragraphs = $('#mw-content-text p')
          .filter((_, el) => $(el).text().trim() !== '')
          .map((_, el) => $(el).text().trim())
          .get()
          .join('\n\n')

        if (!paragraphs) {
          return '此页面目前没有内容。'
        }

        // 如果内容太长，只返回前600个字符
        const content = paragraphs.length > 600
          ? paragraphs.slice(0, 600) + '...'
          : paragraphs

        return `${content}\n\n链接：${searchUrl}`
      } catch (error) {
        return `查询失败：${error.message}`
      }
    })

  ctx.command('mcwiki.search <keyword:text>', '搜索Minecraft Wiki')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入搜索关键词'

      try {
        const lang = userLangs.get(session.userId) || config.defaultLang
        const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
        const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.maxResults}`
        
        const [_, titles, descriptions, urls] = await axios.get(searchUrl).then(res => res.data)
        
        if (!titles.length) return '未找到相关结果'

        const results = titles.map((title, i) => ({
          title,
          description: descriptions[i],
          url: urls[i]
        }))

        let msg = '搜索结果:\n' + results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
        msg += '\n\n请输入序号查看对应页面'
        
        ctx.emit('mcwiki-search-select', results, session)
        return msg

      } catch (error) {
        return `搜索失败: ${error.message}`
      }
    })

  ctx.on('mcwiki-search-select', (results, session) => {
    const dispose = ctx.middleware((session2, next) => {
      if (session.userId !== session2.userId) return next()
      
      const num = parseInt(session2.content)
      if (isNaN(num) || num < 1 || num > results.length) {
        session.send('无效的序号，请重新输入')
        return
      }

      const result = results[num - 1]
      session.execute(`mcwiki.s ${result.title}`)
      dispose()
    })

    setTimeout(() => {
      session.send('搜索超时，已取消')
      dispose()
    }, config.searchTimeout)
  })

  ctx.command('mcwiki.shot <keyword:text>', '获取Minecraft Wiki页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const lang = userLangs.get(session.userId) || config.defaultLang
        const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
        const pageUrl = `https://${domain}/w/${encodeURIComponent(keyword)}`

        const context = await ctx.puppeteer.browser.createBrowserContext()
        const page = await context.newPage()
        
        await page.setViewport({
          width: config.viewportWidth,
          height: config.viewportHeight,
          deviceScaleFactor: 1
        })

        await page.goto(pageUrl, { 
          waitUntil: 'networkidle0',
          timeout: config.timeout 
        })

        await page.waitForSelector('#mw-content-text')
        const element = await page.$('#mw-content-text')
        const height = await element.evaluate(el => el.scrollHeight)
        
        const screenshot = await element.screenshot({
          type: 'png',
          clip: {
            x: 0,
            y: 0,
            width: config.viewportWidth,
            height: Math.min(height, config.viewportHeight)
          }
        })

        await context.close()

        if (height > config.viewportHeight) {
          await session.send(`页面过长，仅显示部分内容。完整页面: ${pageUrl}`)
        }

        return h.image(screenshot, 'image/png')

      } catch (error) {
        return `截图失败: ${error.message}`
      }
    })
}
