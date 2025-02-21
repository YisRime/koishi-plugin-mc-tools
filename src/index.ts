import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

import {
  formatErrorMessage,
  MinecraftToolsConfig,
  LANGUAGES,
  LangCode,
  checkMinecraftUpdate,
  queryServerStatus,
  fetchMinecraftVersions,
} from './utils'
import {
  searchMCMOD,
  processMCMODContent
} from './modwiki'
import {
  processWikiRequest,
  getWikiConfiguration,
  constructUrl,
} from './mcwiki'

export const name = 'mc-tools'
export const inject = {required: ['puppeteer']}


export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    defaultLanguage: Schema.union(Object.keys(LANGUAGES) as LangCode[])
      .default('zh')
      .description('Wiki 显示语言'),
    pageTimeout: Schema.number()
      .default(30)
      .description('Wiki 页面加载超时时间，单位：秒'),
    searchTimeout: Schema.number()
      .default(10)
      .description('搜索结果选择等待时间，超时将取消操作，单位：秒'),
    searchResultLimit: Schema.number()
      .default(10)
      .description('Wiki 和 MCMOD 搜索结果的最大显示数量'),
    minSectionLength: Schema.number()
      .default(12)
      .description('Wiki 段落的最小字数，低于此字数的段落将被忽略'),
    sectionPreviewLength: Schema.number()
      .default(50)
      .description('除 Wiki 首段外，其他段落的预览字数上限'),
    totalPreviewLength: Schema.number()
      .default(500)
      .description('整个预览内容的总字数上限'),
    searchDescLength: Schema.number()
      .default(60)
      .description('MCMOD 搜索结果中每个条目描述的最大字数'),
    imageEnabled: Schema.boolean()
      .default(true)
      .description('是否启用 Wiki 页面截图功能')
  }).description('Minecraft Wiki 与 MCMOD 查询相关设置'),

  versionCheck: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('是否启用 Minecraft 版本更新检查功能'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('接收版本更新通知的群组 ID 列表'),
    interval: Schema.number()
      .default(60)
      .description('版本检查间隔时间，单位：分钟'),
    notifyOnSnapshot: Schema.boolean()
      .default(true)
      .description('是否在发现新快照版本时发送通知'),
    notifyOnRelease: Schema.boolean()
      .default(true)
      .description('是否在发现新正式版本时发送通知')
  }).description('Minecraft 版本更新检查设置'),

  server: Schema.object({
    host: Schema.string()
      .description('默认的 Minecraft 服务器地址，当未指定地址时使用此值')
      .default('localhost'),
    port: Schema.number()
      .description('默认的服务器端口，标准端口为 25565')
      .default(25565),
    showPlayers: Schema.boolean()
      .default(true)
      .description('是否显示在线玩家列表'),
    showSettings: Schema.boolean()
      .default(true)
      .description('是否显示服务器设置（如正版验证、白名单状态等）'),
    showPing: Schema.boolean()
      .default(true)
      .description('是否显示服务器延迟时间'),
    showIcon: Schema.boolean()
      .default(true)
      .description('是否显示服务器图标（如果有）')
  }).description('Minecraft 服务器查询相关设置')
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, config: MinecraftToolsConfig) {
  const state = {
    versions: { snapshot: '', release: '' }
  }

  // 分离命令处理逻辑
  setupWikiCommands(ctx, config)
  setupModWikiCommands(ctx, config)
  setupServerCommands(ctx, config)
  setupVersionCommands(ctx)

  // 版本更新检查
  if (config.versionCheck.enabled && config.versionCheck.groups.length) {
    setupVersionCheck(ctx, config, state.versions)
  }
}

function setupWikiCommands(ctx: Context, config: MinecraftToolsConfig) {
  const mcwiki = ctx.command('mcwiki', 'Minecraft Wiki 查询')
    .usage(`mcwiki <关键词> - 直接查询内容\nmcwiki.search <关键词> - 搜索并选择条目\nmcwiki.shot <关键词> - 获取页面截图`)

  mcwiki.action(async ({ }, keyword) => {
      try {
        const result = await processWikiRequest(keyword, config)
        if (typeof result === 'string') {
          return h.text(result)
        } else if (result && typeof result.getImage === 'function') {
          const { image } = await result.getImage()
          return h.image(image, 'image/png')
        }
        return h.text('')
      } catch (error) {
        return h.text(error.message)
      }
    })

  mcwiki.subcommand('.search <keyword:text>', '搜索 Wiki 页面')
      .action(async ({ session }, keyword) => {
        try {
          const searchResult = await processWikiRequest(keyword, config, ctx, 'search') as any
          if (typeof searchResult === 'string') return h.text(searchResult)

          const { results, domain, variant } = searchResult
          const wikiConfig = { domain, variant, baseApiUrl: '' }
          const searchResultMessage = `Wiki 搜索结果：\n${
            results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
          }\n请回复序号查看对应内容\n（使用 -i 后缀以获取页面截图）`

          await session.send(searchResultMessage)
          const response = await session.prompt(config.wiki.searchTimeout * 1000)

          if (!response) return h.text('操作超时')

          const [input, flag] = response.split('-')
          const index = parseInt(input) - 1

          if (isNaN(index) || index < 0 || index >= results.length) {
            return h.text('请输入有效的序号')
          }

          const result = results[index]

          if (flag?.trim() === 'i') {
            if (!config.wiki.imageEnabled) {
              return h.text('图片功能已禁用')
            }
            await session.send(`正在获取页面...\n完整内容：${constructUrl(wikiConfig, `/w/${encodeURIComponent(result.title)}`)}`)
            const resultImage = await processWikiRequest(keyword, config, ctx, 'image')
            if (typeof resultImage === 'string') {
              return h.text(resultImage)
            } else if (resultImage && typeof resultImage.getImage === 'function') {
              const { image } = await resultImage.getImage()
              return h.image(image, 'image/png')
            }
            return h.text('')
          }

          const wikiDetails = await processWikiRequest(keyword, config)
          if (typeof wikiDetails === 'string') {
            return h.text(wikiDetails)
          } else if (wikiDetails && typeof wikiDetails.getImage === 'function') {
            const { image } = await wikiDetails.getImage()
            return h.image(image, 'image/png')
          }
          return h.text('')
        } catch (error) {
          return h.text(error.message)
        }
      })

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
      .action(async ({ session }, keyword) => {
        if (!config.wiki.imageEnabled) {
          return h.text('图片功能已禁用')
        }
        try {
          const result = await processWikiRequest(keyword, config, ctx, 'image') as any
          if (typeof result === 'string') return h.text(result)

          await session.send(`正在获取页面...\n完整内容：${result.url}`)
          const { image } = await result.getImage()
          return h.image(image, 'image/png')
        } catch (error) {
          return h.text(error.message)
        }
      })
}

function setupModWikiCommands(ctx: Context, config: MinecraftToolsConfig) {
  const modWikiCommand = ctx.command('modwiki <keyword:text>', 'MCMOD搜索(支持模组/整合包/物品/教程)')
    .usage(`modwiki <关键词> - 直接查询内容\nmodwiki.search <关键词> - 搜索并选择条目\nmodwiki.shot <关键词> - 获取页面截图`)
    .action(async ({ }, keyword) => {
      if (!keyword) return h.text('请输入要查询的关键词')

      try {
        const results = await searchMCMOD(keyword, config.wiki)
        if (!results.length) return h.text('未找到相关内容')

        const result = results[0]
        const content = await processMCMODContent(result.url, config.wiki)
        if (typeof content === 'string') {
          return h.text(content)
        } else if (content && typeof content.getImage === 'function') {
          const { image } = await content.getImage()
          return h.image(image, 'image/png')
        }
        return h.text('')
      } catch (error) {
        return h.text(formatErrorMessage(error))
      }
    })

  modWikiCommand.subcommand('.shot <keyword:text>', '获取 MCMOD 页面截图')
    .action(async ({ session }, keyword) => {
      if (!config.wiki.imageEnabled) {
        return '图片功能已禁用'
      }

      try {
        const results = await searchMCMOD(keyword, config.wiki)
        if (!results.length) return '未找到相关内容'

        await session.send(`正在获取页面...\n完整内容：${results[0].url}`)
        const result = await processMCMODContent(results[0].url, config.wiki, ctx, 'image') as any
        const { image } = await result.getImage()
        return h.image(image, 'image/png')
      } catch (error) {
        return formatErrorMessage(error)
      }
    })

  modWikiCommand.subcommand('.search <keyword:text>', 'MCMOD搜索并返回列表')
      .action(async ({ session }, keyword) => {
        if (!keyword) return h.text('请输入要查询的关键词')

        try {
          const results = await searchMCMOD(keyword, config.wiki)
          if (!results.length) return h.text('未找到相关内容')

          const searchResultMessage = results
            .slice(0, config.wiki.searchResultLimit)
            .map((r, i) => `${i + 1}. ${r.title}${r.desc ? `\n    ${r.desc}` : ''}`)
            .join('\n')

          await session.send(`MCMOD 搜索结果：\n${searchResultMessage}\n请回复序号查看详细内容`)
          const response = await session.prompt(config.wiki.searchTimeout * 1000)

          if (!response) return h.text('操作超时')

          const index = parseInt(response) - 1
          if (isNaN(index) || index < 0 || index >= results.length) {
            return h.text('请输入有效的序号')
          }

          const content = await processMCMODContent(results[index].url, config.wiki)
          if (typeof content === 'string') {
            return h.text(content)
          } else if (content && typeof content.getImage === 'function') {
            const { image } = await content.getImage()
            return h.image(image, 'image/png')
          }
          return h.text('')
        } catch (error) {
          return h.text(formatErrorMessage(error))
        }
      })
}

function setupServerCommands(ctx: Context, config: MinecraftToolsConfig) {
  ctx.command('mcinfo [server]', '查询 Minecraft 服务器状态')
    .action(async (_, server) => {
      let host = config.server.host
      let port = config.server.port

      if (server) {
        const parts = server.split(':')
        host = parts[0]
        if (parts[1]) {
          const parsedPort = parseInt(parts[1])
          if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            return '服务器端口必须是 1-65535 之间的数字'
          }
          port = parsedPort
        }
      }

      const displayAddr = port === 25565 ? host : `${host}:${port}`
      const result = await queryServerStatus(host, port, config.server)

      if (!result.success) {
        return `服务器查询失败: ${result.error}`
      }

      return !server ? `${displayAddr}\n${result.data}` : result.data
    })
}

function setupVersionCommands(ctx: Context) {
  ctx.command('mcver', '获取 Minecraft 最新版本信息')
    .action(async () => {
      try {
        const { latest, release } = await fetchMinecraftVersions()
        const formatDate = (date: string) => new Date(date).toLocaleDateString('zh-CN')

        return `Minecraft 最新版本：\n正式版：${release.id}（${formatDate(release.releaseTime)}）\n快照版：${latest.id}（${formatDate(latest.releaseTime)}）`
      } catch (error) {
        return `Minecraft 版本信息获取失败：${formatErrorMessage(error)}`
      }
    })
}

function setupVersionCheck(ctx: Context, config: MinecraftToolsConfig, versions: any) {
  checkMinecraftUpdate(versions, ctx, config)
  setInterval(() => checkMinecraftUpdate(versions, ctx, config), config.versionCheck.interval * 60 * 1000)
}
