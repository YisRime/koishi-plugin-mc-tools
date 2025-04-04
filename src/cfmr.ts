import axios from 'axios';
import { MTConfig } from './index'

interface SearchModResult {
  source: 'modrinth' | 'curseforge'
  id: string | number
  type: string
  title: string
  description: string
  categories: string[]
}

const TypeMap = {
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
  getTypeInfo(source: 'modrinth' | 'curseforge', type?: string) {
    if (!type) return { valid: true };
    const types = source === 'modrinth'
      ? Object.keys(this.modrinthTypes)
      : Object.values(this.curseforgeTypes);
    return {
      valid: types.includes(type),
      facets: source === 'modrinth' ? [`project_type:${type}`] : undefined,
      classId: source === 'curseforge'
        ? Number(Object.keys(this.curseforgeTypes).find(k => this.curseforgeTypes[k] === type))
        : undefined
    };
  },
  getLocalizedType(source: 'modrinth' | 'curseforge', typeKey: string | number) {
    return source === 'modrinth'
      ? this.modrinthTypes[typeKey] || typeKey
      : this.curseforgeTypeNames[this.curseforgeTypes[typeKey]] || '未知';
  }
}

/**
 * 处理游戏版本列表，过滤快照并合并相似版本
 */
function processGameVersions(versions: string[]): string[] {
  if (!versions?.length) return [];
  // 分离正式版和快照版
  const [stableVersions, snapshotCount] = versions.reduce<[string[], number]>(([stable, count], version) => {
    const isSnapshot = version.includes('exp') || version.includes('pre') ||
                      version.includes('rc') || /\d+w\d+[a-z]/.test(version);
    return isSnapshot ? [stable, count + 1] : [[...stable, version], count];
  }, [[], 0]);
  // 按主版本号分组
  const grouped = stableVersions.reduce((groups, version) => {
    const mainVersion = version.match(/^(\d+\.\d+)/)?.[1] || version;
    groups.set(mainVersion, (groups.get(mainVersion) || []).concat(version));
    return groups;
  }, new Map<string, string[]>());
  // 格式化输出
  const result = Array.from(grouped.entries())
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .map(([main, group]) => group.length > 1 ? `${main}(${group.length}个版本)` : group[0]);
  if (snapshotCount > 0) result.push(`+${snapshotCount}个快照版本`);
  return result;
}

/**
 * 统一API请求函数
 */
async function fetchAPI(url: string, options: any = {}) {
  try {
    const response = await axios({
      url,
      ...options,
      timeout: (options.timeout || 10) * 1000
    });
    return response.data;
  } catch (error) {
    throw new Error(`请求失败: ${error.message}`);
  }
}

/**
 * 统一搜索函数
 */
async function searchMods(
  keyword: string,
  source: 'modrinth' | 'curseforge',
  config: MTConfig,
  cfApiKey?: string,
  type?: string
): Promise<SearchModResult[]> {
  const typeInfo = TypeMap.getTypeInfo(source, type);
  if (!typeInfo.valid) throw new Error(`无效的类型: ${type}`);
  if (source === 'modrinth') {
    const data = await fetchAPI('https://api.modrinth.com/v2/search', {
      params: {
        query: keyword,
        limit: 10,
        facets: typeInfo.facets ? [typeInfo.facets] : undefined,
        offset: 0,
        index: 'relevance'
      },
      timeout: config.Timeout
    });
    return data.hits.map(hit => ({
      source: 'modrinth' as const,
      id: hit.slug,
      type: hit.project_type,
      title: hit.title,
      description: hit.description,
      categories: hit.categories
    }));
  } else {
    const data = await fetchAPI('https://api.curseforge.com/v1/mods/search', {
      headers: { 'x-api-key': cfApiKey },
      params: {
        gameId: 432,
        searchFilter: keyword,
        classId: typeInfo.classId,
        pageSize: 10,
        sortField: 2,
        sortOrder: 'desc'
      },
      timeout: config.Timeout
    });
    return data.data.map(r => ({
      source: 'curseforge' as const,
      id: r.id,
      type: TypeMap.curseforgeTypes[r.classId] || '未知',
      title: r.name,
      description: r.summary,
      categories: r.categories.map(c => typeof c === 'string' ? c : c.name)
    }));
  }
}

/**
 * 获取项目详情
 */
async function getModDetails(
  result: SearchModResult,
  config: MTConfig,
  cfApiKey?: string
): Promise<string> {
  let details, displayType;
  if (result.source === 'modrinth') {
    // 获取Modrinth详情
    const data = await fetchAPI(`https://api.modrinth.com/v2/project/${result.id}`);
    details = {
      title: data.title,
      description: data.body,
      type: data.project_type,
      categories: data.categories,
      requirements: [
        `客户端: ${data.client_side === 'required' ? '必需' : data.client_side === 'optional' ? '可选' : '无需'}`,
        `服务端: ${data.server_side === 'required' ? '必需' : data.server_side === 'optional' ? '可选' : '无需'}`
      ],
      loaders: data.loaders,
      versions: processGameVersions(data.game_versions),
      url: `https://modrinth.com/${data.project_type}/${data.slug}`
    };
    displayType = TypeMap.getLocalizedType('modrinth', data.project_type);
  } else {
    // 获取CurseForge详情
    const data = await fetchAPI(`https://api.curseforge.com/v1/mods/${result.id}`, {
      headers: { 'x-api-key': cfApiKey }
    });
    const descData = await fetchAPI(`https://api.curseforge.com/v1/mods/${result.id}/description`, {
      headers: { 'x-api-key': cfApiKey }
    });
    // 提取版本和加载器信息
    const allVersions = new Set<string>();
    const loaders = new Set<string>();
    data.data.latestFiles?.forEach(file => {
      file.gameVersions?.forEach(version => {
        if (version.includes('Forge') || version.includes('Fabric') ||
            version.includes('NeoForge') || version.includes('Quilt')) {
          loaders.add(version.split('-')[0]);
        } else {
          allVersions.add(version);
        }
      });
    });
    details = {
      title: data.data.name,
      description: descData.data.replace(/<[^>]*>/g, '').replace(/\n\s*\n/g, '\n'),
      type: data.data.classId,
      categories: data.data.categories.map(c => typeof c === 'string' ? c : c.name),
      requirements: [],
      loaders: Array.from(loaders),
      versions: processGameVersions(Array.from(allVersions)),
      url: data.data.links.websiteUrl
    };
    displayType = TypeMap.getLocalizedType('curseforge', data.data.classId);
  }
  // 格式化描述
  let description = details.description;
  if (description.length > config.totalLength) {
    description = description.slice(0, config.totalLength) + '...';
  }
  // 构建输出
  const parts = [
    `${displayType} | ${details.title}（${details.categories.join(', ')}）`,
    details.requirements.length ? details.requirements.join(' | ') : '',
    details.loaders?.length ? `加载器: ${details.loaders.join(', ')}` : '',
    details.versions?.length ? `支持版本: ${details.versions.join(', ')}` : '',
    `详细介绍:\n${description}`,
    `链接: ${details.url}`
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 注册命令处理函数
 */
export function registerModPlatformCommands(mcmod: any, config: MTConfig) {
  mcmod.subcommand('.mr <keyword> [type]', '查询 Modrinth')
    .usage('mc.mod.mr <关键词> [类型] - 查询 Modrinth 内容\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({}, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'modrinth', config, config.cfApi, type);
        if (!results.length) return '未找到相关内容';
        return await getModDetails(results[0], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    })
    .subcommand('.find <keyword> [type]', '搜索 Modrinth')
    .usage('mc.mod.findmr <关键词> [类型] - 搜索 Modrinth 项目\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'modrinth', config, config.cfApi, type);
        if (!results.length) return '未找到相关项目';
        const formattedResults = results.map((r, i) => {
          const description = r.description.length > config.descLength
            ? r.description.slice(0, config.descLength) + '...'
            : r.description;
          return `${i + 1}. ${[
            `${TypeMap.getLocalizedType(r.source, r.type)} | ${r.title}`,
            `分类: ${r.categories.join(', ')}`,
            `描述: ${description}`
          ].join('\n')}`;
        }).join('\n');
        await session.send(`Modrinth 搜索结果：\n${formattedResults}\n请回复序号查看详细内容`);
        const response = await session.prompt(config.Timeout * 1000);
        if (!response) return '操作超时';
        const index = parseInt(response) - 1;
        if (isNaN(index) || index < 0 || index >= results.length) return '请输入有效的序号';
        return await getModDetails(results[index], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    });
  mcmod.subcommand('.cf <keyword> [type]', '查询 CurseForge')
    .usage('mc.mod.cf <关键词> [类型] - 查询 CurseForge 内容\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({}, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'curseforge', config, config.cfApi, type);
        if (!results.length) return '未找到相关内容';
        return await getModDetails(results[0], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    })
    .subcommand('.find <keyword> [type]', '搜索 CurseForge')
    .usage('mc.mod.findcf <关键词> [类型] - 搜索 CurseForge 项目\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'curseforge', config, config.cfApi, type);
        if (!results.length) return '未找到相关项目';
        const formattedResults = results.map((r, i) => {
          const description = r.description.length > config.descLength
            ? r.description.slice(0, config.descLength) + '...'
            : r.description;
          return `${i + 1}. ${[
            `${TypeMap.getLocalizedType(r.source, r.type)} | ${r.title}`,
            `分类: ${r.categories.join(', ')}`,
            `描述: ${description}`
          ].join('\n')}`;
        }).join('\n');
        await session.send(`CurseForge 搜索结果：\n${formattedResults}\n请回复序号查看详细内容`);
        const response = await session.prompt(config.Timeout * 1000);
        if (!response) return '操作超时';
        const index = parseInt(response) - 1;
        if (isNaN(index) || index < 0 || index >= results.length) return '请输入有效的序号';
        return await getModDetails(results[index], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    });
}