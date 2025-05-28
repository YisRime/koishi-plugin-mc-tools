import { Context, Session } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { getModrinthProject } from './modrinth'
import { getCurseForgeProject } from './curseforge'
import { getMcmodProject, getMcmodModpack, getMcmodPost, getMcmodItem } from './mcmod'
import { getMcwikiPage } from './mcwiki'

/**
 * 链接解析器配置数组
 * 每个解析器包含正则表达式和对应的处理函数
 */
const LINK_PARSERS = [
  {
    /** Modrinth 项目链接匹配规则 */
    regex: /modrinth\.com\/(?:mod|modpack|resourcepack|shader|datapack|plugin)\/([a-zA-Z0-9_-]+)/,
    handler: (ctx, match, config) => config.modrinthEnabled && getModrinthProject(ctx, match[1], config)
  },
  {
    /** CurseForge 项目链接匹配规则 */
    regex: /(?:www\.)?curseforge\.com\/(?:minecraft\/(?:mc-mods|modpacks|texture-packs|worlds|bukkit-plugins|customization)\/([a-zA-Z0-9_-]+)(?:\/files\/(\d+))?|projects\/(\d+))/,
    handler: async (ctx, match, config) => {
      if (!config.curseforgeEnabled) return null
      if (match[3]) return getCurseForgeProject(ctx, parseInt(match[3]), config.curseforgeEnabled)
      if (!match[1]) return null
      const { data } = await ctx.http.get('https://api.curseforge.com/v1/mods/search', {
        headers: { 'x-api-key': config.curseforgeEnabled },
        params: { gameId: 432, slug: match[1], pageSize: 1 }
      })
      return data?.[0]?.id ? getCurseForgeProject(ctx, data[0].id, config.curseforgeEnabled) : null
    }
  },
  {
    /** MCMOD 项目链接匹配规则 */
    regex: /(?:www\.)?mcmod\.cn\/(?:(class|modpack|post|item)\/(\d+)\.html|(?:class|modpack|post|item)\/(\d+))/,
    handler: (ctx, match, config) => {
      if (!config.mcmodEnabled) return null
      const type = match[1] || ['class', 'modpack', 'post', 'item'].find(t => match[0].includes(t)) || 'class'
      const id = parseInt(match[2] || match[3])
      if (!id) return null
      const handlers = { class: getMcmodProject, modpack: getMcmodModpack, post: getMcmodPost, item: getMcmodItem }
      return handlers[type]?.(ctx, { name: `${type} ${id}`, url: match[0], extra: { id, type } }, config)
    }
  },
  {
    /** Minecraft Wiki 页面链接匹配规则 */
    regex: /(?:(?:zh|en)\.)?minecraft\.wiki\/(?:w\/|wiki\/)?([^#?&\s]+)/,
    handler: async (ctx, match, config) => {
      if (!config.mcwikiEnabled) return null
      const pageTitle = decodeURIComponent(match[1]).replace(/_/g, ' ')
      const { query: { pages } } = await ctx.http.get('https://zh.minecraft.wiki/api.php', {
        params: { action: 'query', titles: pageTitle, format: 'json' }
      })
      const pageId = pages && Object.keys(pages)[0]
      return pageId !== '-1' ? getMcwikiPage(ctx, parseInt(pageId), config) : null
    }
  }
]

/**
 * 解析消息内容中的链接并处理
 * @param ctx - Koishi 上下文对象
 * @param session - 会话对象
 * @param content - 要解析的消息内容
 * @param config - 插件配置
 * @returns 处理结果或 null
 */
async function parseAndProcess(ctx: Context, session: Session, content: string, config: Config) {
  for (const { regex, handler } of LINK_PARSERS) {
    const match = content.match(regex)
    if (!match) continue
    try {
      const result = await handler(ctx, match, config)
      if (result) return await renderOutput(session, result.content, result.url, ctx, config, config.linkParserEnabled === 'shot')
    } catch (error) {
      ctx.logger.error(`链接解析失败:`, error.message)
    }
  }
  return null
}

/**
 * 注册链接解析中间件
 * 监听消息并自动解析其中包含的 Minecraft 相关链接
 * @param ctx - Koishi 上下文对象
 * @param config - 插件配置
 */
export function registerLinkParser(ctx: Context, config: Config) {
  ctx.middleware(async (session, next) => {
    const isValidMessage = session.type?.includes('message') || session.type === 'send'
    const isCommand = session.content?.match(/^[./#!]/) || session.argv?.name
    if (isValidMessage && session.content?.trim() && !isCommand) {
      try {
        const result = await parseAndProcess(ctx, session, session.content, config)
        if (result) return session.send(result)
      } catch (error) {
        ctx.logger.error('链接解析错误:', error.message)
      }
    }
    return next()
  })
}