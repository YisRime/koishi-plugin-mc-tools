import axios from 'axios';
import { TypeMap } from './index'

interface SearchModResult {
  source: 'modrinth' | 'curseforge'
  id: string | number
  type: string
  title: string
  description: string
  categories: string[]
}
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

export async function searchModrinth(keyword: string, facets?: string[]): Promise<ModrinthProject[]> {
  const response = await axios.get('https://api.modrinth.com/v2/search', {
    params: {
      query: keyword,
      limit: 10,
      facets: facets ? [facets] : undefined,
      offset: 0,
      index: 'relevance'
    }
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

export function formatFullModrinthResult(project: ModrinthProject, maxLength: number): string {
  const clientSide = project.client_side === 'required' ? '必需' : project.client_side === 'optional' ? '可选' : '无需';
  const serverSide = project.server_side === 'required' ? '必需' : project.server_side === 'optional' ? '可选' : '无需';
  const requirements = [];
  if (project.loaders?.length) requirements.push(`加载器: ${project.loaders.join(', ')}`);
  requirements.push(`客户端: ${clientSide}`, `服务端: ${serverSide}`);

  let body = project.body.replace(/\n\n+/g, '\n');
  if (body.length > maxLength) {
    body = body.slice(0, maxLength) + '...';
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

export async function searchCurseforge(keyword: string, cfApiKey: string, classId?: number): Promise<CurseForgeProject[]> {
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
    }
  });

  return response.data.data;
}

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

export function formatFullCurseforgeResult(project: CurseForgeProject, maxLength: number): string {
  const typeInChinese = TypeMap.curseforgeTypeNames[TypeMap.curseforgeTypes[project.classId]] || '未知'

  let description = project.description || project.summary;
  // 移除HTML标签和多余的空白行
  description = description.replace(/<[^>]*>/g, '');
  description = description.replace(/\n\s*\n/g, '\n');
  if (description.length > maxLength) {
    description = description.slice(0, maxLength) + '...';
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
 * 根据类型名称获取 CurseForge 的 classId
 */
function getCurseForgeClassId(type: string): number | undefined {
  const englishType = Object.entries(TypeMap.curseforgeTypeNames).find(([_, cn]) => cn === type)?.[0] || type
  const entry = Object.entries(TypeMap.curseforgeTypes).find(([_, t]) => t === englishType)
  return entry ? Number(entry[0]) : undefined
}

/**
 * 根据类型名称获取 Modrinth 的 facets
 */
function getModrinthFacets(type: string): string[] | undefined {
  if (!type) return undefined
  const englishType = Object.entries(TypeMap.modrinthTypes).find(([_, cn]) => cn === type)?.[0] || type
  return [`project_type:${englishType}`]
}

/**
 * 统一搜索函数
 */
export async function searchMods(
  keyword: string,
  source: 'modrinth' | 'curseforge',
  cfApiKey?: string,
  type?: string
): Promise<SearchModResult[]> {
  if (type && !TypeMap.isValidType(source, type)) {
    throw new Error(`无效的类型: ${type}`)
  }

  if (source === 'modrinth') {
    const facets = type ? getModrinthFacets(type) : undefined
    const results = await searchModrinth(keyword, facets)
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
    const results = await searchCurseforge(keyword, cfApiKey, classId)
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
 */
export async function getModDetails(result: SearchModResult, cfApiKey?: string, maxLength: number = 400) {
  if (result.source === 'modrinth') {
    const details = await getModrinthDetails(result.id as string)
    return formatFullModrinthResult(details, maxLength)
  } else {
    const details = await getCurseforgeDetails(result.id as number, cfApiKey)
    return formatFullCurseforgeResult(details, maxLength)
  }
}

/**
 * 格式化搜索结果列表
 */
export function formatSearchResults(results: SearchModResult[], descLength: number = 20): string {
  return results.map((r, i) => {
    let description = r.description;
    if (description.length > descLength) {
      description = description.slice(0, descLength) + '...';
    }
    return `${i + 1}. ${[
      `${r.type} | ${r.title}`,
      `分类: ${r.categories.join(', ')}`,
      `描述: ${description}`
    ].join('\n')}`
  }).join('\n');
}
