import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { registerWikiCommands } from './wiki'
import { registerModCommands } from './mod'
import { registerVersionCommands } from './ver'
import { registerSkinCommands } from './skin'
import { registerInfoCommands } from './info'
import { registerRunCommands } from './link'
import { initWebSocketCommunication, registerWsCommands, cleanupWebSocket, McEvent } from './ws'

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
  common: CommonConfig & {
    maxHeight: number
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
    captureTimeout: number
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
    enabledRcon: boolean
    defaultRcon: string
    rconPassword: string
    sudoUsers: string[]
    enabledWs: boolean
    mode: 'client' | 'server'
    defaultWs: string
    token: string
    serverName: string
    groups: string[]
    events: number
  }
}

/**
 * 插件配置模式
 */
export const Config: Schema<MinecraftToolsConfig> = Schema.object({
  common: Schema.object({
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
  }).description('服务器配置'),

  link: Schema.object({
    groups: Schema.array(String)
      .default(['onebot:12345678'])
      .description('通信和命令的目标群组 ID'),
    sudoUsers: Schema.array(String)
      .default([])
      .description('允许发送命令的用户 ID'),
    enabledRcon: Schema.boolean()
      .default(false)
      .description('开启 RCON 功能'),
    defaultRcon: Schema.string()
      .default('localhost:25575')
      .description('默认 RCON 地址'),
    rconPassword: Schema.string()
      .role('secret')
      .description('RCON 密码'),
    enabledWs: Schema.boolean()
      .default(false)
      .description('开启 WebSocket 功能'),
    defaultWs: Schema.string()
      .default('localhost:8080')
      .description('默认 WebSocket 地址'),
    token: Schema.string()
      .role('secret')
      .description('Access Token'),
    mode: Schema.union(['client', 'server'])
      .default('client')
      .description('WebSocket 工作模式'),
    serverName: Schema.string()
      .default('Server')
      .description('服务器名称'),
    events: Schema.bitset(McEvent)
      .default(McEvent.chat | McEvent.join | McEvent.quit | McEvent.death)
      .description('监听事件类型')
  }).description('服务器配置'),
})

/**
 * 插件主函数
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 */
export function apply(ctx: Context, pluginConfig: MinecraftToolsConfig) {
  const userLanguageSettings = new Map<string, LangCode>()

  // 创建 mc 主命令
  const mcCommand = ctx.command('mc', 'Minecraft 工具')

  // 注册各功能子命令
  registerWikiCommands(ctx, mcCommand, pluginConfig, userLanguageSettings)
  registerModCommands(ctx, mcCommand, pluginConfig)
  registerVersionCommands(ctx, mcCommand, pluginConfig)
  registerSkinCommands(ctx, mcCommand, pluginConfig)
  registerInfoCommands(mcCommand, pluginConfig)
  // 只有在启用 RCON 时才注册相关命令
  if (pluginConfig.link.enabledRcon) {
    registerRunCommands(mcCommand, pluginConfig)
  }
  // 只有在启用 WebSocket 时才注册相关命令和初始化通信
  if (pluginConfig.link.enabledWs) {
    registerWsCommands(mcCommand, pluginConfig, ctx)
    initWebSocketCommunication(ctx, pluginConfig)
  }
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
  // 清理 WebSocket 资源
  cleanupWebSocket()
}
