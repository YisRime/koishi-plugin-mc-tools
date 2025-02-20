import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import {} from 'koishi-plugin-puppeteer'
import * as mc from 'minecraft-protocol'
import {
  checkSearchCooldown,
  handleError,
  getWikiDomain,
  buildWikiUrl,
  getTitleLine,
  getVersionFromProtocol,
  MinecraftToolsConfig,
  LANGUAGES,
  LangCode,
  searchMcmod,
  formatModInfo,
  extractServerText,
  formatServerPlayers,
  getServerSettings,
  searchWiki,
  getWikiContent,
  captureWiki
} from './utils'

export const name = 'mc-tools'
export const inject = {required: ['puppeteer']}


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

  // 通用工具函数
  function checkCooldown(): boolean {
    const result = checkSearchCooldown(lastSearchTime)
    if (typeof result === 'number') {
      lastSearchTime = result
      return true
    }
    return false
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
          const context = await ctx.puppeteer.browser.createBrowserContext()
          const page = await context.newPage()
          try {
            const { image } = await captureWiki(page, pageUrl, lang, config)
            return h.image(image, 'image/png')
          } finally {
            await context.close()
          }
        }

        const { title, content, url } = await getWikiContent(pageUrl, lang, config)
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
      const results = await searchWiki(keyword, config.wiki.searchResultLimit, config.wiki.pageTimeout)

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

      if (mode === 'image') {
        return {
          url: displayUrl,
          async getImage() {
            const context = await ctx.puppeteer.browser.createBrowserContext()
            const page = await context.newPage()
            try {
              const { image } = await captureWiki(page, pageUrl, lang, config)
              return { image }
            } finally {
              await context.close()
            }
          }
        }
      }

      const { title, content, url } = await getWikiContent(pageUrl, lang, config)
      return `『${title}』${content}\n详细内容：${url}`

    } catch (error) {
      return handleError(error)
    }
  }

  // Mod 功能相关代码
  const modwiki = ctx.command('modwiki', 'MCMOD 模组百科查询')
    .usage('modwiki <关键词> - 直接查询\nmodwiki.search <关键词> - 搜索并选择\nmodwiki.link <ID> [type] - 查看相关链接\nmodwiki.relate <ID> [type] - 查看关联内容')

  modwiki.action(async ({ }, keyword) => {
    if (!keyword) return '请输入要查询的模组关键词'
    if (!checkCooldown()) return '搜索太频繁，请稍后再试'

    return await searchAndGetModInfo(keyword, true)
  })

  modwiki.subcommand('.search <keyword:text>', '搜索模组')
    .action(async ({ session }, keyword) => {
      if (!checkCooldown()) return '搜索太频繁，请稍后再试'
      return await searchAndGetModInfo(keyword, false, session)
    })

  modwiki.subcommand('.link <id:number> [type:string]', '查看相关链接')
    .usage('type: class(模组) 或 modpack(整合包)')
    .action(async ({ }, id, type) => await getModRelatedInfo(id, type, 'links'))

  modwiki.subcommand('.relate <id:number> [type:string]', '查看关联内容')
    .usage('type: class(模组) 或 modpack(整合包)')
    .action(async ({ }, id, type) => await getModRelatedInfo(id, type, 'relations'))

  // 封装的搜索和获取信息函数
  async function searchAndGetModInfo(keyword: string, direct = false, session?: any) {
    try {
      const results = await searchMcmod(keyword, config.wiki.mcmodApiBase)
      if (!results) return '未找到相关内容'

      if (direct) return await formatModInfo(results[0], config)

      const msg = results.map((r, i) => {
        const id = r.data?.mcmod_id ? ` (ID: ${r.data.mcmod_id})` : ''
        const type = r.address?.includes('/modpack/') ? '[整合包]' : '[模组]'
        return `${i + 1}. ${type} ${r.title}${id}`
      }).join('\n')

      await session.send(`搜索结果：\n${msg}\n请回复序号查看详情`)
      const response = await session.prompt(10000)

      if (!response) return '操作超时'
      const index = parseInt(response) - 1
      if (isNaN(index) || index < 0 || index >= results.length) {
        return '请输入有效的序号'
      }

      return await formatModInfo(results[index], config)
    } catch (error) {
      return handleError(error)
    }
  }

  async function getModRelatedInfo(id: number, type = 'class', infoType: 'links' | 'relations') {
    if (!checkCooldown()) return '请求太频繁，请稍后再试'
    if (type !== 'class' && type !== 'modpack') return '类型必须是 class(模组) 或 modpack(整合包)'

    try {
      const { data } = await axios.get(`${config.wiki.mcmodApiBase}/d/${type}/${id}`)
      const title = getTitleLine(data)

      if (infoType === 'links') {
        if (!data.related_links?.length) return `该${type === 'modpack' ? '整合包' : '模组'}没有相关链接`

        return [
          `${title} | 相关链接：`,
          ...data.related_links.map(link => `- ${link.text}: ${link.url}`)
        ].join('\n')
      }

      if (!data.mod_relations) return `该${type === 'modpack' ? '整合包' : '模组'}没有关联内容`

      const lines = [`${title} | 关联模组：`]

      Object.entries(data.mod_relations).forEach(([version, relations]) => {
        if (!Array.isArray(relations) || !relations.length) return

        lines.push(`\n${version}：`)
        relations.forEach(relation => {
          if (!relation.mods?.length) return

          lines.push(`- ${relation.relation_type}`)
          relation.mods.forEach(mod => {
            const modId = mod.link.match(/\/class\/(\d+)\.html/)?.[1] || ''
            lines.push(`  • ${mod.name}${modId ? ` (ID: ${modId})` : ''}`)
          })
        })
      })

      return lines.join('\n')
    } catch (error) {
      return handleError(error)
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

        if (client && 'favicon' in client && client.favicon?.startsWith('data:image/png;base64,')) {
          lines.push(h.image(client.favicon).toString())
        }

        const displayAddr = port === 25565 ? host : `${host}:${port}`
        if (!server) {
          lines.push(displayAddr)
        }

        if ('description' in client && client.description) {
          const motd = extractServerText(client.description).trim()
          if (motd) {
            lines.push(motd.replace(/§[0-9a-fk-or]/g, ''))
          }
        }

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

        const players = 'players' in client ? formatServerPlayers(client.players) : { online: 0, max: 0 }
        lines.push(`${versionInfo} | ${players.online}/${players.max} | ${pingTime}ms`)

        const settings = getServerSettings(client)
        if (settings.length) {
          lines.push(settings.join(' | '))
        }

        if (players.sample?.length > 0) {
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
}
