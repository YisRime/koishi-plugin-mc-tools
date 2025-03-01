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
export const usage = '使用 Docker 部署的用户请安装 chromium-swiftshader 来使用 mcskin 指令获取皮肤'
export type LangCode = keyof typeof MINECRAFT_LANGUAGES

const MINECRAFT_LANGUAGES = {
  'zh': '中文（简体）',
  'zh-hk': '中文（繁體）',
  'zh-tw': '中文（台灣）',
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
    'mod': '模组',
    'resourcepack': '资源包',
    'modpack': '整合包',
    'shader': '光影',
    'datapack': '数据包',
    'world': '地图',
    'addon': '附加包',
    'plugin': '插件'
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
    showIcon: boolean
    maxPlayerDisplay: number
    maxModDisplay: number
    javaApis: string[]
    bedrockApis: string[]
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
      .description('搜索项目描述字数'),
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
    showIcon: Schema.boolean()
      .default(true)
      .description('显示服务器图标'),
    maxPlayerDisplay: Schema.number()
      .description('最大显示玩家数')
      .default(8),
    maxModDisplay: Schema.number()
      .description('最大显示 Mod 数')
      .default(8),
    default: Schema.string()
      .description('默认 INFO 服务器')
      .default('localhost:25565'),
    javaApis: Schema.array(String)
      .default([
        'https://api.imlazy.ink/mcapi?type=json&host=${host}:${port}',
        'https://motdbe.blackbe.work/api/java?host=${host}:${port}',
        'https://api.bluesdawn.top/minecraft/server/api?host=${host}:${port}'
      ])
      .description('Java 查询 API'),
    bedrockApis: Schema.array(String)
      .default([
        'https://api.imlazy.ink/mcapi?type=json&host=${host}:${port}&be=true',
        'https://motdbe.blackbe.work/api?host=${host}:${port}',
        'https://api.bedrockinfo.com/v2/status?host=${host}&port=${port}'
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
  const mcwiki = ctx.command('mcwiki <keyword:text>', 'Minecraft Wiki 查询')
    .usage('使用说明：\n  mcwiki <关键词> - 直接查询指定 Wiki 页面\n  mcwiki.find <关键词> - 搜索并选择页面\n  mcwiki.shot <关键词> - 获取页面截图')
    .example('mcwiki 红石 - 直接查看红石页面')
    .example('mcwiki.find 发射器 - 搜索发射器相关页面')
    .example('mcwiki.shot 活塞 - 获取活塞页面截图')

  mcwiki.action(async ({ session }, keyword) => {
    try {
      const result = await processWikiRequest(keyword, session.userId, pluginConfig, userLanguageSettings)
      return result
    } catch (error) {
      return error.message
    }
  })

  mcwiki.subcommand('.find <keyword:text>', '搜索 Wiki 页面')
    .usage('使用说明：\n  mcwiki.find <关键词> - 搜索并列出多个 Wiki 页面供选择')
    .example('mcwiki.find 红石电路 - 搜索红石电路相关页面')
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

  mcwiki.subcommand('.shot <keyword:text>', '获取 Wiki 页面截图')
    .usage('使用说明：\n  mcwiki.shot <关键词> - 截取指定 Wiki 页面截图')
    .example('mcwiki.shot 红石比较器 - 获取红石比较器页面截图')
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

    const modCommand = ctx.command('mod <keyword:text>', 'MCMOD 查询')
    .usage('使用说明：\n  mod <关键词> - 直接搜索并显示第一个匹配的 MCMOD 页面\n  mod.find <关键词> - 搜索并选择 MCMOD 页面\n  mod.shot <关键词> - 获取 MCMOD 页面截图\n  mod.mr/findmr <关键词> [类型] - 搜索 Modrinth\n  mod.cf/findcf <关键词> [类型] - 搜索 CurseForge')
    .example('mod 机械动力 - 直接查看机械动力页面')
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

  modCommand.subcommand('.find <keyword:text>', '搜索 MCMOD 页面')
    .usage('使用说明：\n  mod.find <关键词> - 搜索并列出多个 MCMOD 相关页面供选择')
    .example('mod.find 科技 - 搜索科技相关模组')
    .action(async ({ session }, keyword) => {
      return await search({
        keyword,
        source: 'mcmod',
        session,
        config: pluginConfig,
        ctx
      })
    })

  modCommand.subcommand('.shot <keyword:text>', '搜索并截图 MCMOD 条目')
    .usage('使用说明：\n  mod.shot <关键词> - 搜索并截取 MCMOD 页面截图')
    .example('mod.shot 植物魔法 - 获取植物魔法页面截图')
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

  modCommand.subcommand('.mr <keyword> [type]', 'Modrinth 项目搜索')
    .usage('使用说明：\n  mod.mr <关键词> [类型] - 获取Modrinth项目详情\n可用类型: mod, resourcepack, datapack, shader, modpack, plugin')
    .example('mod.mr fabric - 搜索所有Fabric相关项目')
    .example('mod.mr fabric mod - 只搜索Fabric相关模组')
    .action(async ({ }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', pluginConfig.wiki, undefined, type)
        if (!results.length) return '未找到相关项目'
        return await getModDetails(results[0], pluginConfig.wiki, pluginConfig.search.cfApi)
      } catch (error) {
        return error.message
      }
    })

  modCommand.subcommand('.findmr <keyword> [type]', '搜索 Modrinth 项目')
    .usage('使用说明：\n  mod.findmr <关键词> [类型] - 搜索并列出Modrinth结果\n可用类型: mod, resourcepack, datapack, shader, modpack, plugin')
    .example('mod.findmr fabric - 搜索所有Fabric相关项目')
    .example('mod.findmr fabric mod - 只搜索Fabric相关模组')
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

  modCommand.subcommand('.cf <keyword> [type]', 'CurseForge 项目搜索')
    .usage('使用说明：\n  mod.cf <关键词> [类型] - 获取CurseForge项目详情\n可用类型: mod, resourcepack, modpack, shader, datapack, world, addon, plugin')
    .example('mod.cf fabric - 搜索所有Fabric相关项目')
    .example('mod.cf fabric mod - 只搜索Fabric相关模组')
    .action(async ({ }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', pluginConfig.wiki, pluginConfig.search.cfApi, type)
        if (!results.length) return '未找到相关项目'
        return await getModDetails(results[0], pluginConfig.wiki, pluginConfig.search.cfApi)
      } catch (error) {
        return error.message
      }
    })

  modCommand.subcommand('.findcf <keyword> [type]', '搜索 CurseForge 项目')
    .usage('使用说明：\n  mod.findcf <关键词> [类型] - 搜索并列出CurseForge结果\n可用类型: mod, resourcepack, modpack, shader, datapack, world, addon, plugin')
    .example('mod.findcf fabric - 搜索所有Fabric相关项目')
    .example('mod.findcf fabric mod - 只搜索Fabric相关模组')
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

  ctx.command('mcver', '获取 Minecraft 最新版本')
    .usage('使用说明：\n  mcver - 获取最新的Minecraft版本信息')
    .action(async () => {
      const result = await getVersionInfo()
      return result.success ? result.data : result.error
    })

  if (pluginConfig.ver.enabled && pluginConfig.ver.groups.length) {
    checkUpdate(minecraftVersions, ctx, pluginConfig)
    setInterval(() => checkUpdate(minecraftVersions, ctx, pluginConfig), pluginConfig.ver.interval * 60 * 1000)
  }

  ctx.command('mcinfo [server]', '查询 MC 服务器状态')
    .usage('使用说明：\n  mcinfo [地址[:端口]] - 查询Java版服务器状态\n  mcinfo.be [地址[:端口]] - 查询基岩版服务器状态')
    .example('mcinfo mc.hypixel.net - 查询Java版服务器')
    .example('mcinfo.be play.lbsg.net - 查询基岩版服务器')
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || pluginConfig.info.default, 'java', pluginConfig)
        return formatServerStatus(status, pluginConfig.info)
      } catch (error) {
        return error.message
      }
    })
    .subcommand('.be [server]', '查询基岩版服务器状态')
    .example('mcinfo.be mc.example.com:19133')
    .action(async ({ }, server) => {
      try {
        const status = await checkServerStatus(server || pluginConfig.info.default, 'bedrock', pluginConfig)
        return formatServerStatus(status, pluginConfig.info)
      } catch (error) {
        return error.message
      }
    })

  ctx.command('mcskin <username>', '查询 Minecraft 玩家信息')
    .usage('使用说明：\n  mcskin <用户名> - 获取玩家信息与3D皮肤预览')
    .example('mcskin Notch - 获取Notch的信息和皮肤')
    .action(async ({ }, username) => {
      if (!username) return '请输入要查询的用户名';

      try {
        const profile = await getPlayerProfile(username);
        const parts = [
          `${profile.name}[${profile.uuidDashed}]${profile.skin ? ` (${profile.skin.model === 'slim' ? '纤细' : '经典'})` : ''}`
        ];

        if (profile.skin) {
          const skinImage = await renderPlayerSkin(ctx, profile.skin.url, profile.cape?.url);
          parts.push(h.image(`data:image/png;base64,${skinImage}`).toString());
          parts.push(`获取 ${profile.name} 的头(≤1.12 或 ≥1.13):`);
          parts.push(`/give @p minecraft:skull 1 3 {SkullOwner:"${profile.name}"}`);
          parts.push(`/give @p minecraft:player_head{SkullOwner:"${profile.name}"}`);
        } else {
          parts.push('未设置皮肤');
        }
        return parts.join('\n');
      } catch (error) {
        return error.message
      }
  })
}
