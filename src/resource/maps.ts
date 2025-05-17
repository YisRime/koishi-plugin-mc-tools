import { searchModrinthProjects, getModrinthProject } from './modrinth'
import { searchCurseForgeProjects, getCurseForgeProject } from './curseforge'
import { searchMcmodProjects, getMcmodProject } from './mcmod'
import { searchMcwikiPages, getMcwikiPage } from './mcwiki'

/**
 * 支持的平台配置，包含各平台的搜索、详情获取和数据转换方法
 * @type {Object}
 */
export const PLATFORMS = {
  modrinth: {
    name: 'Modrinth',
    /**
     * 搜索Modrinth项目
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Array>} 搜索结果列表
     */
    search: (ctx, keyword, config, options = {}) => searchModrinthProjects(ctx, keyword, options),
    /**
     * 获取Modrinth项目详情
     * @type {Function}
     */
    getDetail: getModrinthProject,
    /**
     * 转换Modrinth项目数据为统一格式
     * @param {Object} p - 项目数据
     * @returns {Object} 统一格式的项目数据
     */
    transform: p => ({
      platform: 'Modrinth', name: p.title, description: p.description,
      url: `https://modrinth.com/${p.project_type}/${p.slug}`,
      extra: { id: p.project_id, type: p.project_type, author: p.author, downloads: p.downloads }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.modrinthEnabled
  },
  curseforge: {
    name: 'CurseForge',
    /**
     * 搜索CurseForge项目
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Object>} 包含结果和分页信息的对象
     */
    search: (ctx, keyword, config, options = {}) => searchCurseForgeProjects(ctx, keyword, config.curseforgeEnabled, options),
    /**
     * 获取CurseForge项目详情
     * @param {Context} ctx - Koishi上下文
     * @param {string} id - 项目ID
     * @param {Config} config - 配置对象
     * @returns {Promise<Object>} 项目详情
     */
    getDetail: (ctx, id, config) => getCurseForgeProject(ctx, id, config.curseforgeEnabled),
    /**
     * 转换CurseForge项目数据为统一格式
     * @param {Object} p - 项目数据
     * @returns {Object} 统一格式的项目数据
     */
    transform: p => ({
      platform: 'CurseForge', name: p.name, description: p.summary,
      url: p.links?.websiteUrl || '',
      extra: { id: p.id, author: p.authors.map(a => a.name).join(', '), downloads: p.downloadCount, type: p.classId }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.curseforgeEnabled
  },
  mcmod: {
    name: 'MCMOD',
    /**
     * 搜索MCMOD项目
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Object>} 包含结果和分页信息的对象
     */
    search: (ctx, keyword, config, options = {}) => searchMcmodProjects(ctx, keyword, options, config),
    /**
     * 获取MCMOD项目详情
     * @param {Context} ctx - Koishi上下文
     * @param {string} id - 项目ID
     * @param {Config} config - 配置对象
     * @returns {Promise<Object>} 项目详情
     */
    getDetail: (ctx, id, config) => getMcmodProject(ctx, id, config),
    /**
     * 转换MCMOD项目数据为统一格式
     * @param {Object} p - 项目数据
     * @returns {Object} 统一格式的项目数据
     */
    transform: p => ({
      platform: 'MCMOD', name: p.name, description: p.description, url: p.url,
      extra: { id: p.id, type: p.type, category: p.category }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => !!config.mcmodEnabled
  },
  mcwiki: {
    name: 'Minecraft Wiki',
    /**
     * 搜索Minecraft Wiki页面
     * @param {Context} ctx - Koishi上下文
     * @param {string} keyword - 搜索关键词
     * @param {Config} config - 配置对象
     * @param {Object} options - 搜索选项
     * @returns {Promise<Array>} 搜索结果列表
     */
    search: (ctx, keyword, config, options = {}) => searchMcwikiPages(ctx, keyword, options),
    /**
     * 获取Minecraft Wiki页面详情
     * @param {Context} ctx - Koishi上下文
     * @param {string} id - 页面ID
     * @param {Config} config - 配置对象
     * @returns {Promise<Object>} 页面详情
     */
    getDetail: getMcwikiPage,
    /**
     * 转换Minecraft Wiki页面数据为统一格式
     * @param {Object} p - 页面数据
     * @returns {Object} 统一格式的页面数据
     */
    transform: p => ({
      platform: 'Minecraft Wiki', name: p.title, description: p.snippet.replace(/<\/?[^>]+(>|$)/g, ''),
      url: `https://zh.minecraft.wiki/w/${encodeURIComponent(p.title)}`,
      extra: { id: p.pageid }
    }),
    /**
     * 检查配置是否启用该平台
     * @param {Config} config - 配置对象
     * @returns {boolean} 是否启用
     */
    checkConfig: config => config.mcwikiEnabled
  }
}

/**
 * CurseForge相关映射表
 * @type {Object}
 */
export const CF_MAPS = {
  /** 资源类型映射 */
  TYPE: {
    'mod': 6, 'resourcepack': 12, 'world': 17, 'plugin': 5,
    'modpack': 4471, 'addon': 4559, 'customization': 4546,
    'shader': 6552, 'datapack': 6945
  },
  /** 加载器类型映射 */
  LOADER: {
    'any': 0, 'forge': 1, 'cauldron': 2, 'liteloader': 3,
    'fabric': 4, 'quilt': 5, 'neoforge': 6
  },
  /** 发布类型映射 */
  RELEASE: { 1: '正式版', 2: '快照版', 3: '开发版' },
  /** 依赖关系映射 */
  RELATION: { 1: '必需', 2: '可选', 3: '不兼容', 4: '内置', 5: '工具' }
}

/**
 * 状态映射表
 * @type {Object}
 */
export const STATUS_MAP = {
  compatibility: { required: '必需', optional: '可选', unsupported: '不支持' },
  type: { mod: '模组', modpack: '整合包', resourcepack: '资源包', shader: '着色器' }
}

/**
 * MCMOD相关映射表
 * @type {Object}
 */
export const MCMOD_MAPS = {
  /** 搜索过滤器映射 */
  FILTER: {
    'mod': 1,       // 模组
    'modpack': 2,   // 整合包
    'item': 3,      // 资料
    'post': 4,      // 教程
    'author': 5,    // 作者
    'user': 6,      // 用户
    'community': 7  // 社群
  },
  /** 资源类型映射 */
  RESOURCE_TYPE: {
    '1': '物品/方块',
    '2': '生物',
    '3': '附魔',
    '4': '世界生成',
    '5': '维度',
    '6': 'BUFF/DEBUFF',
    '7': '多方块结构',
    '8': '自然生成',
    '9': '绑定热键',
    '10': '游戏设定',
    '11': '指令',
    '12': 'API',
    '191': '编辑规范'
  },
  /** 整合包分类映射 */
  CATEGORY: {
    '1': '科技',
    '2': '魔法',
    '3': '冒险',
    '4': '建筑',
    '5': '地图',
    '6': '任务',
    '7': '硬核',
    '8': '休闲',
    '9': '大型',
    '10': '轻量',
    '11': '剧情',
    '12': '水槽',
    '13': '空岛',
    '14': 'PvP',
    '15': '国创'
  },
  /** 模组分类映射 */
  MOD_CATEGORY: {
    '1': '科技',
    '2': '魔法',
    '3': '冒险',
    '4': '农业',
    '5': '装饰',
    '6': '安全',
    '7': 'API',
    '8': '资源',
    '9': '世界',
    '10': '群系',
    '11': '生物',
    '12': '能源',
    '13': '存储',
    '14': '物流',
    '15': '道具',
    '16': '红石',
    '17': '食物',
    '18': '模型',
    '19': '指南',
    '20': '破坏',
    '21': '自定义',
    '22': 'Meme',
    '23': '实用',
    '24': '脚本',
    '25': '中式',
    '26': '日式',
    '27': '西式',
    '28': '恐怖',
    '29': '建材',
    '30': '生存',
    '31': '指令',
    '32': '优化',
    '33': '国创',
    '34': '关卡',
    '35': '结构'
  },
  /** 资源类型映射 */
  TYPE: {
    'class': '模组',
    'modpack': '整合包',
    'item': '资料',
    'post': '教程',
    'author': '作者',
    'user': '用户',
    'community': '社群'
  }
}