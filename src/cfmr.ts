import axios from 'axios';
import { TypeMap } from './index'
import { CommonConfig, MTConfig } from './index'
import { sendForwardMessage } from './wikiservice';

/**
 * 模组搜索结果的统一接口
 * @interface SearchModResult
 * @property {('modrinth'|'curseforge')} source - 模组来源平台
 * @property {string|number} id - 模组ID，Modrinth为字符串，CurseForge为数字
 * @property {string} type - 模组类型
 * @property {string} title - 模组标题
 * @property {string} description - 模组描述
 * @property {string[]} categories - 模组分类
 */
interface SearchModResult {
  source: 'modrinth' | 'curseforge'
  id: string | number
  type: string
  title: string
  description: string
  categories: string[]
}

/**
 * Modrinth项目信息接口
 * @interface ModrinthProject
 * @property {string} slug - 项目短名称
 * @property {string} title - 项目标题
 * @property {string} description - 项目简短描述
 * @property {string[]} categories - 项目分类
 * @property {string} client_side - 客户端兼容性
 * @property {string} server_side - 服务端兼容性
 * @property {string} project_type - 项目类型
 * @property {string} body - 项目详细描述
 * @property {string[]} [game_versions] - 支持的游戏版本列表
 * @property {string[]} [loaders] - 支持的加载器列表
 */
interface ModrinthProject {
  slug: string
  title: string
  description: string
  categories: string[]
  client_side: string
  server_side: string
  project_type: string
  body: string
  game_versions?: string[]
  loaders?: string[]
}

/**
 * CurseForge项目信息接口
 * @interface CurseForgeProject
 * @property {number} id - 项目ID
 * @property {string} name - 项目名称
 * @property {string} summary - 项目摘要
 * @property {string} description - 项目详细描述
 * @property {(string|{name:string})[]} categories - 项目分类
 * @property {number} classId - 项目类别ID
 * @property {{displayName:string,gameVersions:string[]}[]} latestFiles - 最新文件列表
 * @property {{websiteUrl:string}} links - 相关链接
 */
interface CurseForgeProject {
  id: number
  name: string
  summary: string
  description: string
  categories: (string | { name: string })[]
  classId: number
  latestFiles: {
    displayName: string
    gameVersions: string[]
  }[]
  links: {
    websiteUrl: string
  }
}

/**
 * 在Modrinth平台搜索项目
 * @param {string} keyword - 搜索关键词
 * @param {CommonConfig} config - 通用配置
 * @param {string[]} [facets] - 搜索过滤条件
 * @returns {Promise<ModrinthProject[]>} 搜索结果列表
 */
export async function searchModrinth(keyword: string, config: CommonConfig, facets?: string[]): Promise<ModrinthProject[]> {
  const response = await axios.get('https://api.modrinth.com/v2/search', {
    params: {
      query: keyword,
      limit: 10,
      facets: facets ? [facets] : undefined,
      offset: 0,
      index: 'relevance'
    },
    timeout: config.Timeout * 1000
  });

  return response.data.hits.map(hit => ({
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    categories: hit.categories,
    project_type: hit.project_type,
  }));
}

/**
 * 处理游戏版本列表，过滤快照并合并相似版本
 * @param {string[]} versions - 原始版本列表
 * @returns {string[]} 处理后的版本列表
 */
function processGameVersions(versions: string[]): string[] {
  if (!versions?.length) return [];

  const [stableVersions, snapshotCount] = versions.reduce<[string[], number]>(([stable, count], version) => {
    const isSnapshot = version.includes('exp') ||
                      version.includes('pre') ||
                      version.includes('rc') ||
                      /\d+w\d+[a-z]/.test(version);
    return isSnapshot ? [stable, count + 1] : [[...stable, version], count];
  }, [[], 0]);

  const grouped = stableVersions.reduce((groups, version) => {
    const mainVersion = version.match(/^(\d+\.\d+)/)?.[1] || version;
    groups.set(mainVersion, (groups.get(mainVersion) || []).concat(version));
    return groups;
  }, new Map<string, string[]>());

  const result = Array.from(grouped.entries())
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .map(([main, group]) =>
      group.length > 1 ? `${main}(${group.length}个版本)` : group[0]
    );

  if (snapshotCount > 0) {
    result.push(`+${snapshotCount}个快照版本`);
  }

  return result;
}

/**
 * 获取Modrinth项目的详细信息
 * @param {string} slug - 项目的slug标识符
 * @returns {Promise<ModrinthProject>} 项目详细信息
 */
export async function getModrinthDetails(slug: string): Promise<ModrinthProject> {
  const response = await axios.get(`https://api.modrinth.com/v2/project/${slug}`);
  const {
    slug: projectSlug,
    title,
    description,
    body,
    client_side,
    server_side,
    categories,
    project_type,
    game_versions,
    loaders
  } = response.data;

  return {
    slug: projectSlug,
    title,
    description,
    body,
    client_side,
    server_side,
    categories,
    project_type,
    game_versions: processGameVersions(game_versions),
    loaders
  };
}

/**
 * 格式化Modrinth项目的完整结果为可读文本
 * @param {ModrinthProject} project - Modrinth项目信息
 * @param {CommonConfig} config - 通用配置
 * @returns {string} 格式化后的项目信息文本
 */
export function formatFullModrinthResult(project: ModrinthProject, config: CommonConfig): string {
  const clientSide = project.client_side === 'required' ? '必需' : project.client_side === 'optional' ? '可选' : '无需';
  const serverSide = project.server_side === 'required' ? '必需' : project.server_side === 'optional' ? '可选' : '无需';
  const requirements = [];
  if (project.loaders?.length) requirements.push(`加载器: ${project.loaders.join(', ')}`);
  requirements.push(`客户端: ${clientSide}`, `服务端: ${serverSide}`);

  let body = project.body.replace(/\n\n+/g, '\n');
  if (body.length > config.totalLength) {
    body = body.slice(0, config.totalLength) + '...';
  }

  const parts = [
    `${TypeMap.modrinthTypes[project.project_type] || project.project_type} | ${project.title}（${project.categories.join(', ')}）`,
    requirements.join(' | '),
    project.game_versions?.length ? `支持版本: ${project.game_versions.join(', ')}` : '',
    `详细介绍:\n${body}`,
    `链接: https://modrinth.com/${project.project_type}/${project.slug}`
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 在CurseForge平台搜索项目
 * @param {string} keyword - 搜索关键词
 * @param {string} cfApiKey - CurseForge API密钥
 * @param {CommonConfig} config - 通用配置
 * @param {number} [classId] - 项目类别ID
 * @returns {Promise<CurseForgeProject[]>} 搜索结果列表
 */
export async function searchCurseforge(keyword: string, cfApiKey: string, config: CommonConfig, classId?: number): Promise<CurseForgeProject[]> {
  const response = await axios.get('https://api.curseforge.com/v1/mods/search', {
    headers: {
      'x-api-key': cfApiKey
    },
    params: {
      gameId: 432,
      searchFilter: keyword,
      classId,
      pageSize: 10,
      sortField: 2,
      sortOrder: 'desc'
    },
    timeout: config.Timeout * 1000
  });

  return response.data.data;
}

/**
 * 获取CurseForge项目的详细信息
 * @param {number} modId - 项目ID
 * @param {string} cfApiKey - CurseForge API密钥
 * @returns {Promise<CurseForgeProject>} 项目详细信息
 */
export async function getCurseforgeDetails(modId: number, cfApiKey: string): Promise<CurseForgeProject> {
  // 获取基本信息
  const response = await axios.get(`https://api.curseforge.com/v1/mods/${modId}`, {
    headers: {
      'x-api-key': cfApiKey
    }
  });

  // 获取详细描述
  const descResponse = await axios.get(`https://api.curseforge.com/v1/mods/${modId}/description`, {
    headers: {
      'x-api-key': cfApiKey
    }
  });

  return {
    ...response.data.data,
    description: descResponse.data.data
  };
}

/**
 * 格式化CurseForge项目的完整结果为可读文本
 * @param {CurseForgeProject} project - CurseForge项目信息
 * @param {CommonConfig} config - 通用配置
 * @returns {string} 格式化后的项目信息文本
 */
function formatFullCurseforgeResult(project: CurseForgeProject, config: CommonConfig): string {
  const typeInChinese = TypeMap.curseforgeTypeNames[TypeMap.curseforgeTypes[project.classId]] || '未知'

  let description = project.description || project.summary;
  // 移除HTML标签和多余的空白行
  description = description.replace(/<[^>]*>/g, '');
  description = description.replace(/\n\s*\n/g, '\n');
  if (description.length > config.totalLength) {
    description = description.slice(0, config.totalLength) + '...';
  }

  const allGameVersions = new Set<string>();
  const loaders = new Set<string>();
  project.latestFiles?.forEach(file => {
    file.gameVersions?.forEach(version => {
      if (version.includes('Forge') || version.includes('Fabric') ||
          version.includes('NeoForge') || version.includes('Quilt')) {
        loaders.add(version.split('-')[0]);
      } else {
        allGameVersions.add(version);
      }
    });
  });

  const gameVersions = processGameVersions(Array.from(allGameVersions));

  const parts = [
    `${typeInChinese} | ${project.name}（${project.categories.map(c => typeof c === 'string' ? c : c.name).join(', ')}）`,
    loaders.size ? `加载器: ${Array.from(loaders).join(', ')}` : '',
    gameVersions.length ? `支持版本: ${gameVersions.join(', ')}` : '',
    `详细介绍:\n${description}`,
    `链接: ${project.links.websiteUrl}`
  ];

  return parts.filter(Boolean).join('\n');
}

/**
 * 根据类型名称获取CurseForge的classId
 * @param {string} type - 项目类型名称
 * @returns {number|undefined} 对应的classId或undefined
 */
function getCurseForgeClassId(type: string): number | undefined {
  const englishType = Object.entries(TypeMap.curseforgeTypeNames).find(([_, cn]) => cn === type)?.[0] || type
  const entry = Object.entries(TypeMap.curseforgeTypes).find(([_, t]) => t === englishType)
  return entry ? Number(entry[0]) : undefined
}

/**
 * 根据类型名称获取Modrinth的facets过滤条件
 * @param {string} type - 项目类型名称
 * @returns {string[]|undefined} 对应的facets过滤条件或undefined
 */
function getModrinthFacets(type: string): string[] | undefined {
  if (!type) return undefined
  const englishType = Object.entries(TypeMap.modrinthTypes).find(([_, cn]) => cn === type)?.[0] || type
  return [`project_type:${englishType}`]
}

/**
 * 统一搜索函数，可搜索Modrinth或CurseForge平台
 * @param {string} keyword - 搜索关键词
 * @param {('modrinth'|'curseforge')} source - 搜索平台
 * @param {CommonConfig} config - 通用配置
 * @param {string} [cfApiKey] - CurseForge API密钥
 * @param {string} [type] - 项目类型
 * @returns {Promise<SearchModResult[]>} 统一格式的搜索结果列表
 * @throws {Error} 当类型无效或搜索失败时抛出错误
 */
async function searchMods(
  keyword: string,
  source: 'modrinth' | 'curseforge',
  config: CommonConfig,
  cfApiKey?: string,
  type?: string
): Promise<SearchModResult[]> {
  if (type && !TypeMap.isValidType(source, type)) {
    throw new Error(`无效的类型: ${type}`)
  }

  if (source === 'modrinth') {
    const facets = type ? getModrinthFacets(type) : undefined
    const results = await searchModrinth(keyword, config, facets)
    return results.map(r => ({
      source: 'modrinth' as const,
      id: r.slug,
      type: r.project_type,
      title: r.title,
      description: r.description,
      categories: r.categories
    }))
  } else {
    const classId = type ? getCurseForgeClassId(type) : undefined
    const results = await searchCurseforge(keyword, cfApiKey, config, classId)
    return results.map(r => ({
      source: 'curseforge' as const,
      id: r.id,
      type: TypeMap.curseforgeTypes[r.classId] || '未知',
      title: r.name,
      description: r.summary,
      categories: r.categories.map(c => typeof c === 'string' ? c : c.name)
    }))
  }
}

/**
 * 统一获取项目详情
 * @param {SearchModResult} result - 搜索结果项
 * @param {CommonConfig} config - 通用配置
 * @param {string} [cfApiKey] - CurseForge API密钥
 * @returns {Promise<string>} 格式化后的项目详情文本
 */
async function getModDetails(
  result: SearchModResult,
  config: CommonConfig,
  cfApiKey?: string
) {
  if (result.source === 'modrinth') {
    const details = await getModrinthDetails(result.id as string)
    return formatFullModrinthResult(details, config)
  } else {
    const details = await getCurseforgeDetails(result.id as number, cfApiKey)
    return formatFullCurseforgeResult(details, config)
  }
}

/**
 * 格式化搜索结果列表为可读文本
 * @param {SearchModResult[]} results - 搜索结果列表
 * @param {CommonConfig} config - 通用配置
 * @returns {string} 格式化后的结果列表文本
 */
function formatSearchResults(results: SearchModResult[], config: CommonConfig): string {
  return results.map((r, i) => {
    let description = r.description;
    if (description.length > config.descLength) {
      description = description.slice(0, config.descLength) + '...';
    }
    return `${i + 1}. ${[
      `${r.type} | ${r.title}`,
      `分类: ${r.categories.join(', ')}`,
      `描述: ${description}`
    ].join('\n')}`
  }).join('\n');
}

/**
 * 注册Modrinth和CurseForge相关命令
 * @param {any} mcmod - MCMOD命令对象
 * @param {MTConfig} config - 插件配置
 */
export function registerModPlatformCommands(mcmod: any, config: MTConfig) {
  mcmod.subcommand('.mr <keyword> [type]', '查询 Modrinth')
    .usage('mc.mod.mr <关键词> [类型] - 查询 Modrinth 内容\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', config.common, undefined, type)
        if (!results.length) return '未找到相关内容'

        // 检查是否使用合并转发
        if (config.common.useForwardMsg) {
          // 获取无长度限制的详细内容
          const tempConfig = { ...config.common, totalLength: 10000 };
          const fullContent = await getModDetails(results[0], tempConfig, config.specific.cfApi);
          const url = `https://modrinth.com/${results[0].type}/${results[0].id}`;

          try {
            const response = await sendForwardMessage(session, results[0].title, fullContent, url);
            // 如果返回字符串，说明平台不支持合并转发，直接返回内容
            if (typeof response === 'string') {
              return response;
            }
            return '';
          } catch (error) {
            return `合并转发消息发送失败: ${error.message}\n请访问: ${url}`;
          }
        }

        return await getModDetails(results[0], config.common, config.specific.cfApi)
      } catch (error) {
        return error.message
      }
    })
    .subcommand('.find <keyword> [type]', '搜索 Modrinth')
    .usage('mc.mod.findmr <关键词> [类型] - 搜索 Modrinth 项目\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'modrinth', config.common, undefined, type)
        if (!results.length) return '未找到相关项目'

        await session.send('Modrinth 搜索结果：\n' + formatSearchResults(results, config.common) + '\n请回复序号查看详细内容')

        const response = await session.prompt(config.common.Timeout * 1000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        // 检查是否使用合并转发
        if (config.common.useForwardMsg) {
          // 获取无长度限制的详细内容
          const tempConfig = { ...config.common, totalLength: 10000 };
          const fullContent = await getModDetails(results[index], tempConfig, config.specific.cfApi);
          const url = `https://modrinth.com/${results[index].type}/${results[index].id}`;

          try {
            const response = await sendForwardMessage(session, results[index].title, fullContent, url);
            // 如果返回字符串，说明平台不支持合并转发，直接返回内容
            if (typeof response === 'string') {
              return response;
            }
            return '';
          } catch (error) {
            return `合并转发消息发送失败: ${error.message}\n请访问: ${url}`;
          }
        }

        return await getModDetails(results[index], config.common, config.specific.cfApi)
      } catch (error) {
        return error.message
      }
    })

  mcmod.subcommand('.cf <keyword> [type]', '查询 CurseForge')
    .usage('mc.mod.cf <关键词> [类型] - 查询 CurseForge 内容\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', config.common, config.specific.cfApi, type)
        if (!results.length) return '未找到相关内容'

        // 检查是否使用合并转发
        if (config.common.useForwardMsg) {
          // 获取无长度限制的详细内容
          const tempConfig = { ...config.common, totalLength: 10000 };
          const fullContent = await getModDetails(results[0], tempConfig, config.specific.cfApi);
          const url = results[0].source === 'curseforge' ?
            `https://www.curseforge.com/minecraft/${results[0].type}s/${results[0].title.toLowerCase().replace(/\s+/g, '-')}` : '';

          try {
            const response = await sendForwardMessage(session, results[0].title, fullContent, url);
            // 如果返回字符串，说明平台不支持合并转发，直接返回内容
            if (typeof response === 'string') {
              return response;
            }
            return '';
          } catch (error) {
            return `合并转发消息发送失败: ${error.message}\n请访问: ${url}`;
          }
        }

        return await getModDetails(results[0], config.common, config.specific.cfApi)
      } catch (error) {
        return error.message
      }
    })
    .subcommand('.find <keyword> [type]', '搜索 CurseForge')
    .usage('mc.mod.findcf <关键词> [类型] - 搜索 CurseForge 项目\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const results = await searchMods(keyword, 'curseforge', config.common, config.specific.cfApi, type)
        if (!results.length) return '未找到相关项目'

        await session.send('CurseForge 搜索结果：\n' + formatSearchResults(results, config.common) + '\n请回复序号查看详细内容')

        const response = await session.prompt(config.common.Timeout * 1000)
        if (!response) return '操作超时'

        const index = parseInt(response) - 1
        if (isNaN(index) || index < 0 || index >= results.length) {
          return '请输入有效的序号'
        }

        // 检查是否使用合并转发
        if (config.common.useForwardMsg) {
          // 获取无长度限制的详细内容
          const tempConfig = { ...config.common, totalLength: 10000 };
          const fullContent = await getModDetails(results[index], tempConfig, config.specific.cfApi);
          const url = results[index].source === 'curseforge' ?
            `https://www.curseforge.com/minecraft/${results[index].type}s/${results[index].title.toLowerCase().replace(/\s+/g, '-')}` : '';

          try {
            const response = await sendForwardMessage(session, results[index].title, fullContent, url);
            // 如果返回字符串，说明平台不支持合并转发，直接返回内容
            if (typeof response === 'string') {
              return response;
            }
            return '';
          } catch (error) {
            return `合并转发消息发送失败: ${error.message}\n请访问: ${url}`;
          }
        }

        return await getModDetails(results[index], config.common, config.specific.cfApi)
      } catch (error) {
        return error.message
      }
    })
}
