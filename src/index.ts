import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { registerWikiCommands } from './wiki'
import { registerModCommands } from './mod'
import { registerInfoCommands } from './tool'
import { registerServerCommands } from './link'
import { initWebSocket, cleanupWebSocket } from './linkservice'

/**
 * Minecraft 工具箱插件
 * @module mc-tools
 */
export const name = 'mc-tools'
export const inject = {optional: ['puppeteer']}
export const usage = '注意：使用 Docker 部署产生的问题请前往插件主页查看解决方案'

// 版本检查定时器
let verCheckTimer: NodeJS.Timeout

export type LangCode = keyof typeof MINECRAFT_LANGUAGES

/**
 * 支持的Minecraft语言
 */
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

/**
 * 类型映射相关配置
 */
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
  /**
   * 验证类型是否有效
   * @param source 源站点
   * @param type 类型
   * @returns 是否有效
   */
  isValidType: (source: 'modrinth' | 'curseforge', type?: string): boolean => {
    if (!type) return true
    const types = source === 'modrinth' ? Object.keys(TypeMap.modrinthTypes) : Object.values(TypeMap.curseforgeTypes)
    return types.includes(type as any)
  }
}

/**
 * 服务器配置接口
 */
export interface ServerConfig {
  name: string
  connect: string
  rconAddress: string
  rconPassword: string
  websocketMode: 'client' | 'server'
  websocketAddress: string
  websocketToken: string
}

/**
 * 插件完整配置接口
 */
export interface MTConfig {
    Timeout: number
    totalLength: number
    descLength: number
    maxHeight?: number
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
    captureTimeout?: number
    useForward?: boolean
    Language: LangCode
    sectionLength: number
    linkCount: number
    cfApi: string
    showImages: 'always' | 'noqq' | 'never'
    default: string
    showIP: boolean
    showIcon: boolean
    maxNumber: number
    javaApis: string[]
    bedrockApis: string[]
    showSkull: boolean
    verCheck: boolean
    guilds: string[]
    interval: number
    release: boolean
    snapshot: boolean
    enableRcon: boolean
    rconAddress: string
    rconPassword: string
    websocketMode: 'client' | 'server'
    websocketAddress: string
    websocketToken: string
    enableWebSocket: boolean
    name: string
    connect: string
}

/**
 * 插件配置模式
 */
export const Config: Schema<MTConfig> = Schema.intersect([
  Schema.object({
    useForward: Schema.boolean()
      .description('启用合并转发').default(false),
    totalLength: Schema.number()
      .description('总预览字数').default(400),
    sectionLength: Schema.number()
      .description('Wiki 每段预览字数').default(50),
    descLength: Schema.number()
      .description('搜索列表描述字数').default(20),
    linkCount: Schema.number()
      .description('MCMod 相关链接个数').default(4),
    Timeout: Schema.number()
      .description('搜索超时时间（秒）').default(15),
    captureTimeout: Schema.number()
      .description('截图超时时间（秒）').default(3),
    maxHeight: Schema.number()
      .description('截图最大高度（像素）').default(4096),
    waitUntil: Schema.union(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
      .description('截图等待条件').default('domcontentloaded'),
    Language: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .description('Wiki 显示语言').default('zh'),
    showImages: Schema.union(['always', 'noqq', 'never' ])
      .description('MCMod 简介图片展示平台').default('noqq'),
    cfApi: Schema.string()
      .description('CurseForge API Key').role('secret'),
  }).description('查询配置'),

  Schema.object({
    verCheck: Schema.boolean()
      .description('启用更新检查').default(false),
    release: Schema.boolean()
      .description('正式版本通知').default(true),
    snapshot: Schema.boolean()
      .description('快照版本通知').default(true),
    interval: Schema.number()
      .description('检查间隔时间（分钟）').default(5),
    guilds: Schema.array(String)
      .description('更新通知目标(platform:guild/private:target)')
      .default(['onebot:private:123456789', 'onebot:guild:123456789']),
    showSkull: Schema.boolean()
      .description('显示如何获取玩家头颅').default(true),
    showIP: Schema.boolean()
      .description('显示服务器地址').default(false),
    showIcon: Schema.boolean()
      .description('显示服务器图标').default(true),
    maxNumber: Schema.number()
      .description('列表最大显示个数').default(8),
    default: Schema.string()
      .description('默认 INFO 地址').default('hypixel.net'),
    javaApis: Schema.array(String)
      .description('Java 查询 API')
      .default(['https://api.mcstatus.io/v2/status/java/${address}',
        'https://api.mcsrvstat.us/3/${address}']),
    bedrockApis: Schema.array(String)
      .description('Bedrock 查询 API')
      .default(['https://api.mcstatus.io/v2/status/bedrock/${address}',
        'https://api.mcsrvstat.us/bedrock/3/${address}']),
  }).description('工具配置'),

  Schema.object({
    connect: Schema.string()
      .description('互联群组ID').default('onebot:123456789'),
    enableRcon: Schema.boolean()
      .description('启用 RCON').default(false),
    rconAddress: Schema.string()
      .description('RCON 地址').default('localhost:25575'),
    rconPassword: Schema.string()
      .description('RCON 密码').role('secret'),
    enableWebSocket: Schema.boolean()
      .description('启用 WebSocket').default(false),
    name: Schema.string()
      .description('服务器名称').default('Server'),
    websocketMode: Schema.union(['client', 'server'])
      .description('WebSocket 模式'),
    websocketAddress: Schema.string()
      .description('WebSocket 地址').default('localhost:8080'),
    websocketToken: Schema.string()
      .description('WebSocket 密码').role('secret'),
  }).description('鹊桥互联配置'),
])

/**
 * 插件主函数
 */
export function apply(ctx: Context, config: MTConfig) {
  // 用户语言设置
  const userLanguageSettings = new Map<string, LangCode>()
  // 创建 mc 主命令
  const mcCommand = ctx.command('mc', 'Minecraft 工具')
  // 注册各功能子命令
  registerWikiCommands(ctx, mcCommand, config, userLanguageSettings)
  registerModCommands(ctx, mcCommand, config)
  // 注册服务器信息和版本查询命令
  verCheckTimer = registerInfoCommands(ctx, mcCommand, config)
  // 注册服务器管理命令
  if (config.enableRcon || config.enableWebSocket) {
    registerServerCommands(mcCommand, config)
    if (config.enableWebSocket) {
      initWebSocket(ctx, config)
    }
  }
}

/**
 * 插件卸载函数
 */
export function dispose() {
  if (verCheckTimer) {
    clearInterval(verCheckTimer)
    verCheckTimer = null
  }
  cleanupWebSocket()
}
