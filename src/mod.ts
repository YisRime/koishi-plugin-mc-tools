import axios from 'axios';
import { TypeMap, ModrinthProject } from './utils'

export async function searchModrinth(keyword: string, facets?: string[]): Promise<ModrinthProject[]> {
  const response = await axios.get('https://api.modrinth.com/v2/search', {
    params: {
      query: keyword,
      limit: 10,
      facets: facets
    }
  });

  // 只保留搜索结果显示所需的字段
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

  // 分离快照版本和稳定版本
  const [stableVersions, snapshotCount] = versions.reduce<[string[], number]>(([stable, count], version) => {
    const isSnapshot = version.includes('exp') ||
                      version.includes('pre') ||
                      version.includes('rc') ||
                      /\d+w\d+[a-z]/.test(version);
    return isSnapshot ? [stable, count + 1] : [[...stable, version], count];
  }, [[], 0]);

  // 按主版本号分组并排序
  const grouped = stableVersions.reduce((groups, version) => {
    const mainVersion = version.match(/^(\d+\.\d+)/)?.[1] || version;
    groups.set(mainVersion, (groups.get(mainVersion) || []).concat(version));
    return groups;
  }, new Map<string, string[]>());

  // 格式化输出
  const result = Array.from(grouped.entries())
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .map(([main, group]) =>
      group.length > 1 ? `${main}(${group.length}个版本)` : group[0]
    );

  // 添加快照版本计数
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
    team_members,
    project_type,
    gallery,
    published,
    updated,
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
    author: team_members?.[0]?.user?.username || '未知',
    project_type,
    gallery: gallery || [],
    published: new Date(published).toLocaleString('zh-CN'),
    updated: new Date(updated).toLocaleString('zh-CN'),
    game_versions: processGameVersions(game_versions),
    loaders
  };
}

export function formatFullModrinthResult(project: ModrinthProject): string {
  const clientSide = project.client_side === 'required' ? '必需' : project.client_side === 'optional' ? '可选' : '不需要';
  const serverSide = project.server_side === 'required' ? '必需' : project.server_side === 'optional' ? '可选' : '不需要';

  const parts = [
    `${TypeMap.projectTypes[project.project_type] || project.project_type} | ${project.title}（${project.categories.join(', ')}）`,
    `客户端: ${clientSide} | 服务端: ${serverSide}`,
    project.loaders?.length ? `加载器: ${project.loaders.join(', ')}` : '',
    project.game_versions?.length ? `支持版本: ${project.game_versions.join(', ')}` : '',
    `详细介绍:\n${project.body.replace(/\n\n+/g, '\n')}`,
    `链接: https://modrinth.com/${project.project_type}/${project.slug}`
  ];
  return parts.filter(Boolean).join('\n');
}
