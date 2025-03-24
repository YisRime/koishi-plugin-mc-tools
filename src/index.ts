import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { registerWikiCommands } from './wiki'
import { registerModCommands } from './mod'
import { registerVersionCommands } from './ver'
import { registerSkinCommands } from './skin'
import { registerInfoCommands } from './info'
import { registerServerCommands } from './link'
import { initWebSocketCommunication, McEvent, cleanupWebSocket } from './linkservice'

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
 * 通用配置接口
 */
export interface CommonConfig {
  Timeout: number
  totalLength: number
  descLength: number
  maxHeight?: number
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  captureTimeout?: number
  forward?: boolean
}

/**
 * 服务器配置接口
 */
export interface ServerConfig {
  name: string
  group: string
  rcon: { address: string, password: string }
  websocket: { mode: 'client' | 'server', address: string, token: string }
}

/**
 * 插件完整配置接口
 */
export interface MinecraftToolsConfig {
  common: CommonConfig & {
    maxHeight: number
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
    captureTimeout: number
    forward: boolean
  }
  specific: {
    Language: LangCode
    sectionLength: number
    linkCount: number
    cfApi: string
    showSkull: boolean
    showImages: 'always' | 'noqq' | 'never'
  }
  info: {
    default: string
    showIP: boolean
    showIcon: boolean
    maxNumberDisplay: number
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
  link: {
    servers: ServerConfig[]
    events: number
  }
}

/**
 * 插件配置模式
 */
export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  common: Schema.object({
    forward: Schema.boolean()
      .default(false)
      .description('启用合并转发消息'),
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
    ]).default('domcontentloaded')
      .description('截图等待条件')
  }).description('查询配置'),

  specific: Schema.object({
    sectionLength: Schema.number()
      .default(50)
      .description('Wiki 每段预览字数'),
    linkCount: Schema.number()
      .default(4)
      .description('MCMod 相关链接显示个数'),
    Language: Schema.union(Object.keys(MINECRAFT_LANGUAGES) as LangCode[])
      .default('zh')
      .description('Wiki 显示语言'),
    showImages: Schema.union([
      'always',
      'noqq',
      'never'
    ]).default('noqq')
      .description('MCMod 简介图片展示平台'),
    cfApi: Schema.string()
      .role('secret')
      .description('CurseForge API Key'),
    showSkull: Schema.boolean()
      .default(true)
      .description('显示如何获取玩家头颅')
  }).description('特定配置'),

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
  }).description('更新检测配置'),

  info: Schema.object({
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
  }).description('查询配置'),

  link: Schema.object({
    events: Schema.bitset(McEvent)
      .default(McEvent.玩家聊天 | McEvent.玩家命令 | McEvent.玩家加入 | McEvent.玩家退出)
      .description('监听事件类型'),
    servers: Schema.array(Schema.object({
      name: Schema.string()
        .required()
        .pattern(/^[a-zA-Z0-9_]+$/)
        .description('服务器名称'),
      group: Schema.string()
        .description('互联群组 ID'),
      rcon: Schema.object({
        address: Schema.string()
          .default('localhost:25575')
          .description('RCON 地址'),
        password: Schema.string()
          .role('secret')
          .description('RCON 密码')
      }),
      websocket: Schema.object({
        mode: Schema.union(['client', 'server'])
          .default('client')
          .description('WebSocket 模式'),
        address: Schema.string()
          .default('localhost:8080')
          .description('WebSocket 地址'),
        token: Schema.string()
          .role('secret')
          .description('WebSocket 令牌')
      })
    })).default([{
      name: 'default',
      group: 'sandbox:default',
      rcon: {
        address: 'localhost:25575',
        password: ''
      },
      websocket: {
        mode: 'client',
        address: 'localhost:8080',
        token: ''
      }
    }]),
  }).description('互联配置'),
})

/**
 * 插件主函数
 */
export function apply(ctx: Context, pluginConfig: MinecraftToolsConfig) {
  // 用户语言设置
  const userLanguageSettings = new Map<string, LangCode>()
  // 创建 mc 主命令
  const mcCommand = ctx.command('mc', 'Minecraft 工具')
  // 注册各功能子命令
  registerWikiCommands(ctx, mcCommand, pluginConfig, userLanguageSettings)
  registerModCommands(ctx, mcCommand, pluginConfig)
  registerVersionCommands(ctx, mcCommand, pluginConfig)
  registerSkinCommands(ctx, mcCommand, pluginConfig)
  registerInfoCommands(mcCommand, pluginConfig)
  // 判断是否启用服务器连接功能
  const hasServerConfig = pluginConfig.link.servers.some(server =>
    server.rcon.password || server.websocket.token
  )
  // 如果配置了服务器，则注册服务器管理命令
  if (hasServerConfig) {
    registerServerCommands(mcCommand, pluginConfig, ctx)
    initWebSocketCommunication(ctx, pluginConfig)
  }
}

/**
 * 插件卸载函数
 */
export function dispose() {
  if (versionCheckTimer) {
    clearInterval(versionCheckTimer)
    versionCheckTimer = null
  }
  cleanupWebSocket()
}
