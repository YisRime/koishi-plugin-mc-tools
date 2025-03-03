import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { getVersionInfo, checkUpdate } from './utils'
import { fetchModContent, formatContent } from './modwiki'
import { processWikiRequest } from './mcwiki'
import { searchMod, search, capture } from './subwiki'
import { getPlayerProfile, renderPlayerSkin } from './utils'
import { searchMods, getModDetails, formatSearchResults } from './mod'
import { checkServerStatus, formatServerStatus } from './info'

/**
 * Minecraft 工具箱插件
 * @module mc-tools
 */
export const name = 'mc-tools'
export const inject = {optional: ['puppeteer']}
export const usage = '注意：若使用 Docker 部署，需安装 chromium-swiftshader 以支持 mcskin 指令'
export type LangCode = keyof typeof MINECRAFT_LANGUAGES

const MINECRAFT_LANGUAGES = {
  'zh': '简体中文',
  'zh-hk': '繁體中文（香港）',
  'zh-tw': '繁體中文（臺灣）',
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
}

export const TypeMap = {
  modrinthTypes: {
    'mod': '模组',
    'resourcepack': '资源包',
    'datapack': '数据包',
    'shader': '光影',
    'modpack': '整合包',
    'plugin': '插件'
  },
  facets: {
    'mod': ['project_type:mod'],
    'resourcepack': ['project_type:resourcepack'],
    'datapack': ['project_type:datapack'],
    'shader': ['project_type:shader'],
    'modpack': ['project_type:modpack'],
    'plugin': ['project_type:plugin']
  } as const,
  curseforgeTypes: {
    6: 'mod',
    12: 'resourcepack',
    17: 'modpack',
    4471: 'shader',
    4546: 'datapack',
    4944: 'world',
    5141: 'addon',
    5232: 'plugin',
  },
  curseforgeTypeNames: {
    'mod': '模组/扩展',
    'resourcepack': '资源包/材质包',
    'modpack': '整合包',
    'shader': '光影包',
    'datapack': '数据包',
    'world': '地图存档',
    'addon': '附加内容',
    'plugin': '服务器插件'
  },
  isValidType: (source: 'modrinth' | 'curseforge', type?: string): boolean => {
    if (!type) return true
    const types = source === 'modrinth' ? Object.keys(TypeMap.modrinthTypes) : Object.values(TypeMap.curseforgeTypes)
    return types.includes(type as any)
  }
}
export interface CommonConfig {
  Timeout: number
  totalLength: number
  descLength: number
}
export interface MinecraftToolsConfig {
  wiki: CommonConfig
  search: {
    Language: LangCode
    sectionLength: number
    linkCount: number
    cfApi: string
  }
  info: {
    default: string
    showIP: boolean
    showIcon: boolean
    maxNumberDisplay: number
    javaApis: string[]
    bedrockApis: string[]
    showSkull: boolean
  }
  ver: {
    enabled: boolean
    groups: string[]
    interval: number
    release: boolean
    snapshot: boolean
  }
}

/**
 * 插件配置模式
 */
export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  wiki: Schema.object({
    totalLength: Schema.number()
      .default(400)
      .description('总预览字数'),
    descLength: Schema.number()
      .default(20)
      .description('搜索内容描述字数'),
    Timeout: Schema.number()
      .default(15)
      .description('搜索超时时间（秒）')
  }).description('通用设置'),

  search: Schema.object({
    Language: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .default('zh')
      .description('Wiki 显示语言'),
    sectionLength: Schema.number()
      .default(50)
      .description('Wiki 每段预览字数'),
    linkCount: Schema.number()
      .default(4)
      .description('相关链接最大显示数'),
    cfApi: Schema.string()
      .role('secret')
      .description('CurseForge API Key')
  }).description('查询设置'),

  info: Schema.object({
    showSkull: Schema.boolean()
      .default(true)
      .description('显示头颅获取命令'),
    showIP: Schema.boolean()
      .default(false)
      .description('显示服务器地址'),
    showIcon: Schema.boolean()
      .default(true)
      .description('显示服务器图标'),
    maxNumberDisplay: Schema.number()
      .default(8)
      .description('列表最大显示数'),
    default: Schema.string()
      .default('hypixel.net')
      .description('默认 INFO 服务器'),
    javaApis: Schema.array(String)
      .default([
        'https://api.mcstatus.io/v2/status/java/${address}',
        'https://api.mcsrvstat.us/3/${address}'
      ])
      .description('Java 查询 API'),
    bedrockApis: Schema.array(String)
      .default([
        'https://api.mcstatus.io/v2/status/bedrock/${address}',
        'https://api.mcsrvstat.us/bedrock/3/${address}'
      ])
      .description('Bedrock 查询 API')
  }).description('服务器设置'),

  ver: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用版本更新检查'),
    release: Schema.boolean()
      .default(true)
      .description('通知正式版本'),
    snapshot: Schema.boolean()
      .default(true)
      .description('通知快照版本'),
    interval: Schema.number()
      .default(60)
      .description('检查间隔时间（分钟）'),
    groups: Schema.array(Schema.string())
      .default([])
      .description('接收更新通知 ID')
  }).description('更新检测设置')
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, pluginConfig: MinecraftToolsConfig) {
  const userLanguageSettings = new Map<string, LangCode>()
  const minecraftVersions = { snapshot: '', release: '' }
  const mcwiki = ctx.command('mcwiki <keyword:text>', '查询 Minecraft Wiki')
    .usage('mcwiki <关键词> - 查询 Wiki\nmcwiki.find <关键词> - 搜索 Wiki\nmcwiki.shot <关键词> - 截图 Wiki 页面')
  mcwiki.action(async ({ session }, keyword) => {
    try {
      const result = await processWikiRequest(keyword, session.userId, pluginConfig, userLanguageSettings)
      return result
    } catch (error) {
      return error.message
    }
  })

  mcwiki.subcommand('.find <keyword:text>', '搜索 Wiki')
    .usage('mcwiki.find <关键词> - 搜索 Wiki 页面')
    .action(async ({ session }, keyword) => {
      return await search({
        keyword,
        source: 'wiki',
        session,
        config: pluginConfig,
        ctx,
        lang: userLanguageSettings.get(session.userId) || pluginConfig.search.Language
      })
    })

  mcwiki.subcommand('.shot <keyword:text>', '截图 Wiki 页面')
    .usage('mcwiki.shot <关键词> - 搜索并获取指定页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const wikiResult = await processWikiRequest(keyword, session.userId, pluginConfig, userLanguageSettings, 'image') as any
        if (typeof wikiResult === 'string') return wikiResult

        await session.send(`正在获取页面...\n完整内容：${wikiResult.url}`)
        const result = await capture(
          wikiResult.pageUrl,
          pluginConfig,
          ctx,
          {
            type: 'wiki',
            lang: userLanguageSettings.get(session.userId) || pluginConfig.search.Language
          }
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })

    const mcmod = ctx.command('mcmod <keyword:text>', '查询 MCMod/Modrinth/Curseforge')
    .usage('mcmod <关键词> - 查询 MCMod\nmcmod.find <关键词> - 搜索 MCMod\nmcmod.shot <关键词> - 截图 MCMod 页面\nmcmod.(find)mr <关键词> [类型] - 搜索 Modrinth\nmcmod.(find)cf <关键词> [类型] - 搜索 CurseForge')
    .action(async ({ }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMod(keyword, pluginConfig)
        if (!results.length) return '未找到相关内容'

        const result = results[0]
        const content = await fetchModContent(result.url, pluginConfig.wiki)
        return formatContent(content, result.url, {
          showLinks: pluginConfig.search.linkCount
        })
      } catch (error) {
        return error.message
      }
    })

  mcmod.subcommand('.find <keyword:text>', '搜索 MCMod')
    .usage('mcmod.find <关键词> - 搜索 MCMOD 页面')
    .action(async ({ session }, keyword) => {
      return await search({
        keyword,
        source: 'mcmod',
        session,
        config: pluginConfig,
        ctx
      })
    })

  mcmod.subcommand('.shot <keyword:text>', '截图 MCMod 页面')
    .usage('mcmod.shot <关键词> - 搜索并获取指定页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const results = await searchMod(keyword, pluginConfig)
        if (!results.length) throw new Error('未找到相关内容')
        const targetUrl = results[0].url

        await session.send(`正在获取页面...\n完整内容：${targetUrl}`)
        const result = await capture(
          targetUrl,
          pluginConfig,
          ctx,
          { type: 'mcmod' }
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })

  mcmod.subcommand('.mr <keyword> [type]', '查询 Modrinth')
    .usage('mcmod.mr <关键词> [类型] - 查询 Modrinth 内容\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({ }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', pluginConfig.wiki, undefined, type)
        if (!results.length) return '未找到相关内容'
        return await getModDetails(results[0], pluginConfig.wiki, pluginConfig.search.cfApi)
      } catch (error) {
        return error.message
      }
    })

  mcmod.subcommand('.findmr <keyword> [type]', '搜索 Modrinth')
    .usage('mcmod.findmr <关键词> [类型] - 搜索 Modrinth 项目\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', pluginConfig.wiki, undefined, type)
        if (!results.length) return '未找到相关项目'

        await session.send('Modrinth 搜索结果：\n' + formatSearchResults(results, pluginConfig.wiki) + '\n请回复序号查看详细内容')

        const response = await session.prompt(pluginConfig.wiki.Timeout * 1000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        return await getModDetails(results[index], pluginConfig.wiki, pluginConfig.search.cfApi)
      } catch (error) {
        return error.message
      }
    })

  mcmod.subcommand('.cf <keyword> [type]', '查询 CurseForge')
    .usage('mcmod.cf <关键词> [类型] - 查询 CurseForge 内容\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({ }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', pluginConfig.wiki, pluginConfig.search.cfApi, type)
        if (!results.length) return '未找到相关内容'
        return await getModDetails(results[0], pluginConfig.wiki, pluginConfig.search.cfApi)
      } catch (error) {
        return error.message
      }
    })

  mcmod.subcommand('.findcf <keyword> [type]', '搜索 CurseForge')
    .usage('mcmod.findcf <关键词> [类型] - 搜索 CurseForge 项目\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', pluginConfig.wiki, pluginConfig.search.cfApi, type)
        if (!results.length) return '未找到相关项目'

        await session.send('CurseForge 搜索结果：\n' + formatSearchResults(results, pluginConfig.wiki) + '\n请回复序号查看详细内容')

        const response = await session.prompt(pluginConfig.wiki.Timeout * 1000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        return await getModDetails(results[index], pluginConfig.wiki, pluginConfig.search.cfApi)
      } catch (error) {
        return error.message
      }
    })

  ctx.command('mcver', '查询 Minecraft 版本信息')
    .usage('mcver - 获取 Minecraft 最新版本信息')
    .action(async () => {
      const result = await getVersionInfo()
      return result.success ? result.data : result.error
    })

  if (pluginConfig.ver.enabled && pluginConfig.ver.groups.length) {
    checkUpdate(minecraftVersions, ctx, pluginConfig)
    setInterval(() => checkUpdate(minecraftVersions, ctx, pluginConfig), pluginConfig.ver.interval * 60 * 1000)
  }

  ctx.command('mcinfo [server]', '查询 Minecraft 服务器信息')
    .usage(`mcinfo [地址[:端口]] - 查询 Java 版服务器\nmcinfo.be [地址[:端口]] - 查询 Bedrock 版服务器`)
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || pluginConfig.info.default, 'java', pluginConfig)
        return formatServerStatus(status, pluginConfig.info)
      } catch (error) {
        return error.message
      }
    })
    .subcommand('.be [server]', '查询 Bedrock 版服务器')
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || pluginConfig.info.default, 'bedrock', pluginConfig)
        return formatServerStatus(status, pluginConfig.info)
      } catch (error) {
        return error.message
      }
    })

  ctx.command('mcskin <username>', '查询 Minecraft 玩家信息')
    .usage('mcskin <用户名> - 获取玩家信息并生成皮肤及披风预览')
    .action(async ({ }, username) => {
      if (!username) return '请输入玩家用户名'

      try {
        const profile = await getPlayerProfile(username);
        const parts = [
          `${profile.name}[${profile.uuidDashed}]`
        ];

        if (profile.skin) {
          const skinImage = await renderPlayerSkin(ctx, profile.skin.url, profile.cape?.url);
          parts.push(h.image(`data:image/png;base64,${skinImage}`).toString());

          if (pluginConfig.info.showSkull) {
            parts.push(`使用 /give 获取 ${profile.name} ${profile.skin ? `(${profile.skin.model === 'slim' ? '纤细' : '经典'}) ` : ''}的头：(≤1.12 & ≥1.13)`);
            parts.push(`minecraft:skull 1 3 {SkullOwner:"${profile.name}"}`);
            parts.push(`minecraft:player_head{SkullOwner:"${profile.name}"}`);
          }
        } else {
          parts.push('该玩家未设置皮肤');
        }
        return parts.join('\n');
      } catch (error) {
        return error.message
      }
  })
}
