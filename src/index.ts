import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { registerWikiCommands } from './mcwiki'
import { registerModCommands } from './mcmod'
import { registerModPlatformCommands } from './cfmr'
import { registerVersionCommands } from './mcver'
import { registerSkinCommands } from './mcskin'
import { registerInfoCommands } from './mcinfo'
import { registerRunCommands } from './mcrun'

/**
 * Minecraft 工具箱插件
 * @module mc-tools
 */
export const name = 'mc-tools'
export const inject = {optional: ['puppeteer']}
export const usage = '注意：使用 Docker 部署产生的问题请前往插件主页查看解决方案'

// 版本检查定时器
let versionCheckTimer: NodeJS.Timeout

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
  wiki: CommonConfig & {
    maxHeight: number
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
    captureTimeout: number
  }
  search: {
    Language: LangCode
    sectionLength: number
    linkCount: number
    cfApi: string
    showImages: 'always' | 'noqq' | 'never'
  }
  info: {
    default: string
    defaultRcon: string
    showIP: boolean
    showIcon: boolean
    maxNumberDisplay: number
    javaApis: string[]
    bedrockApis: string[]
    showSkull: boolean
    rconPassword: string
    authorizedRunUsers: string[] // 新增授权用户ID列表
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
      .description('搜索列表描述字数'),
    Timeout: Schema.number()
      .default(15)
      .description('搜索超时时间（秒）'),
    captureTimeout: Schema.number()
      .default(3)
      .description('截图超时时间（秒）'),
    maxHeight: Schema.number()
      .default(4096)
      .min(0)
      .description('截图最大高度（像素）'),
    waitUntil: Schema.union([
      'load',
      'domcontentloaded',
      'networkidle0',
      'networkidle2'
    ])
      .default('domcontentloaded')
      .description('截图完成等待条件')
  }).description('通用查询配置'),

  search: Schema.object({
    Language: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .default('zh')
      .description('Wiki 显示语言'),
    sectionLength: Schema.number()
      .default(50)
      .description('Wiki 每段预览字数'),
    linkCount: Schema.number()
      .default(4)
      .description('MCMod 相关链接显示个数'),
      showImages: Schema.union([
        'always',
        'noqq',
        'never'
      ]).default('noqq')
        .description('MCMod 简介图片展示平台'),
    cfApi: Schema.string()
      .role('secret')
      .description('CurseForge API Key')
  }).description('特定查询配置'),

  info: Schema.object({
    showSkull: Schema.boolean()
      .default(true)
      .description('显示如何获取玩家头颅'),
    showIP: Schema.boolean()
      .default(false)
      .description('显示服务器地址'),
    showIcon: Schema.boolean()
      .default(true)
      .description('显示服务器图标'),
    maxNumberDisplay: Schema.number()
      .default(8)
      .description('列表最大显示个数'),
    default: Schema.string()
      .default('hypixel.net')
      .description('默认 INFO 地址'),
    defaultRcon: Schema.string()
      .default('localhost:25575')
      .description('默认 RCON 地址'),
    rconPassword: Schema.string()
      .role('secret')
      .description('RCON 密码'),
    authorizedRunUsers: Schema.array(String)
      .default([])
      .description('允许执行自定义 RCON 命令的用户 ID'),
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
  }).description('服务器配置'),

  ver: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用更新检查'),
    release: Schema.boolean()
      .default(true)
      .description('正式版本通知'),
    snapshot: Schema.boolean()
      .default(true)
      .description('快照版本通知'),
    interval: Schema.number()
      .default(20)
      .description('检查间隔时间（分钟）'),
    groups: Schema.array(String)
      .default([
        'onebot:private:123456789',
        'discord:group:987654321'
      ])
      .description('更新通知目标')
  }).description('版本更新检测配置')
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, pluginConfig: MinecraftToolsConfig) {
  const userLanguageSettings = new Map<string, LangCode>()

  // 注册 Wiki 命令
  registerWikiCommands(ctx, pluginConfig, userLanguageSettings)
  // 注册 MCMOD 基础命令
  const mcmod = registerModCommands(ctx, pluginConfig)
  // 注册 Modrinth 和 CurseForge 命令
  registerModPlatformCommands(mcmod, pluginConfig)
  // 注册版本相关命令并保存定时器引用
  versionCheckTimer = registerVersionCommands(ctx, pluginConfig)
  // 注册皮肤查询命令
  registerSkinCommands(ctx, pluginConfig)
  // 注册服务器信息查询命令
  registerInfoCommands(ctx, pluginConfig)
  // 注册RCON命令
  registerRunCommands(ctx, pluginConfig)
}

/**
 * 插件卸载函数
 * 清理插件创建的所有定时任务
 */
export function dispose() {
  // 清除版本检查定时器
  if (versionCheckTimer) {
    clearInterval(versionCheckTimer)
    versionCheckTimer = null
  }
}
