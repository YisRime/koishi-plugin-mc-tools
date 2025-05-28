import { Context, Command } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { PLATFORMS, CF_MAPS } from './maps'

/**
 * 准备搜索平台
 */
function preparePlatforms(ctx, options) {
  const validPlatforms = ['modrinth', 'curseforge', 'mcmod', 'mcwiki'];
  if (options.platform) {
    const platforms = options.platform.toLowerCase().split(',').filter(p => validPlatforms.includes(p));
    return platforms.length ? { platformsToSearch: platforms } : { error: '所指定平台无效' };
  }
  const defaultPlatforms = ['modrinth', 'curseforge'];
  return { platformsToSearch: defaultPlatforms };
}

/**
 * 构建Modrinth facets字符串
 */
function buildModrinthFacets(options) {
  const facets = []
  if (options.type) facets.push([`project_type:${options.type}`])
  if (options.version) facets.push([`versions:${options.version}`])
  if (options.loader) facets.push([`categories:${options.loader}`])
  if (options.mrf) {
    try {
      const parsedFacets = JSON.parse(options.mrf)
      if (Array.isArray(parsedFacets)) facets.push(...parsedFacets)
    } catch {}
  }
  return facets.length ? JSON.stringify(facets) : null
}

/**
 * 准备平台选项
 */
function preparePlatformOptions(options, platformStates) {
  return {
    modrinth: {
      facets: options.mrf || buildModrinthFacets(options),
      sort: options.sort, version: options.version, offset: platformStates.modrinth?.offset || 0, limit: 100
    },
    curseforge: {
      categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
      gameVersion: options.version, sortOrder: options.cfo, pageSize: 50,
      modLoaderType: options.loader ? CF_MAPS.LOADER[options.loader] : undefined,
      sortField: options.sort, index: platformStates.curseforge?.offset || 0
    },
    mcmod: { offset: platformStates.mcmod?.offset || 0, type: options.type, mold: options.mcmold ? 1 : 0 },
    mcwiki: { offset: platformStates.mcwiki?.offset || 0, what: options.what }
  };
}

/**
 * 执行单个平台的搜索
 */
async function searchPlatform(ctx, platform, keyword, config, platformOptions, platformStates) {
  const handler = PLATFORMS[platform];
  if (!handler?.checkConfig(config)) return { platform, results: [] };
  try {
    const response = await handler.search(ctx, keyword, config, platformOptions || {});
    // 统一处理不同平台的结果格式
    const results = response?.results || response || [];
    const pagination = response?.pagination || {};
    // 检查是否无结果或结果耗尽
    if (!results?.length) {
      const isExhausted = pagination.exhausted || pagination.totalResults === 0 ||
                         (pagination.page >= pagination.total && pagination.total > 0);
      if (isExhausted) platformStates[platform] = { ...platformStates[platform], exhausted: true };
      return { platform, results: [] };
    }
    const transformedResults = results.map(handler.transform);
    // 计算新的偏移量
    const currentOffset = platformStates[platform]?.offset || 0;
    let newOffset = currentOffset + transformedResults.length;
    // 根据平台和分页信息更新偏移量
    if (platform === 'mcwiki' && pagination.nextOffset !== undefined) {
      newOffset = pagination.nextOffset;
    } else if (pagination.offset !== undefined) {
      newOffset = pagination.offset + results.length;
    } else if (pagination.page && pagination.pageSize) {
      newOffset = pagination.page * pagination.pageSize;
    }
    // 更新平台状态
    platformStates[platform] = {
      offset: newOffset, totalPages: pagination.total || 1, totalResults: pagination.totalResults || 0,
      page: pagination.page || Math.floor(newOffset / (pagination.pageSize || 100)) + 1,
      exhausted: pagination.exhausted || (pagination.page !== undefined && pagination.total ? pagination.page >= pagination.total : false)
    };
    return { platform, results: transformedResults };
  } catch (error) {
    ctx.logger.error(`${handler.name} 搜索失败:`, error);
    return { platform, results: [] };
  }
}

/**
 * 执行搜索
 */
async function executeSearch(ctx, keyword, options, config, platforms, platformStates, platformResults) {
  const activePlatforms = platforms.filter(p => !platformStates[p]?.exhausted);
  if (activePlatforms.length === 0) return { success: true };
  const platformOptions = preparePlatformOptions(options, platformStates);
  // 并行搜索
  const searchResults = await Promise.all(
    activePlatforms.map(platform => searchPlatform(ctx, platform, keyword, config, platformOptions[platform], platformStates))
  );
  // 处理搜索结果
  let totalResults = 0;
  searchResults.forEach(({ platform, results }) => {
    if (!results || results.length === 0) return;
    totalResults += results.length;
    // 执行类型过滤
    if (options.type && platform === 'modrinth' && ['mod', 'modpack', 'resourcepack', 'shader'].includes(options.type)) {
      results = results.filter(i => i.extra?.type === options.type);
    }
    // 将结果添加到平台结果中
    platformResults[platform] = (platformResults[platform] || []).concat(results);
    // 如果结果数量少于每页期望的数量，标记为已耗尽，避免重复搜索
    const expectedPageSizes = { curseforge: 50, mcmod: 30, mcwiki: 10 };
    const expectedPageSize = expectedPageSizes[platform] || 100;
    if (results.length < expectedPageSize && !platformStates[platform]?.exhausted) {
      platformStates[platform] = { ...platformStates[platform], exhausted: true };
    }
  });
  // 结果检查
  const allExhausted = platforms.every(p => platformStates[p]?.exhausted);
  const noResults = Object.values(platformResults).every((r: any[]) => r.length === 0);
  if (allExhausted && noResults) {
    const names = platforms.map(p => PLATFORMS[p]?.name || p).join('、');
    return { success: false,
      message: `${names} 无匹配资源：${options.type ? `类型:${options.type}` : ''}${options.version ? `, 版本:${options.version}` : ''}`
    };
  }
  return { success: true };
}

/**
 * 合并多平台结果
 */
function mergeResults(platformResults) {
  const platforms = Object.keys(platformResults);
  const maxCount = Math.max(...platforms.map(p => platformResults[p].length), 0);
  const allResults = [];
  for (let i = 0; i < maxCount; i++) {
    for (const platform of platforms) {
      if (i < platformResults[platform].length) allResults.push(platformResults[platform][i]);
    }
  }
  return allResults;
}

/**
 * 处理用户输入
 */
async function handleUserInput(input, allResults, currentPage, config, ctx, session, platforms, platformStates, platformResults, options, keyword) {
  if (!input || input?.toLowerCase() === 'c') return { done: true, message: input ? '已取消搜索' : '已超时，自动取消搜索' };
  // 下一页
  if (input.toLowerCase() === 'n') {
    const resultsPerPage = config.searchResults;
    const endIndex = (currentPage + 1) * resultsPerPage;
    // 已有足够结果显示下一页
    if (endIndex < allResults.length) return { done: false, nextPage: currentPage + 1 };
    // 尝试加载更多结果
    const activePlatforms = platforms.filter(p => !platformStates[p]?.exhausted);
    if (activePlatforms.length > 0) {
      const beforeLoadCount = allResults.length;
      await executeSearch(ctx, keyword, options, config, activePlatforms, platformStates, platformResults);
      const newAllResults = mergeResults(platformResults);
      if (newAllResults.length > beforeLoadCount) return { done: false, nextPage: Math.floor(beforeLoadCount / resultsPerPage) };
    }
    return { done: true, message: '无更多结果' };
  }
  // 序号选择
  const choice = parseInt(input);
  if (isNaN(choice) || choice < 1 || choice > allResults.length) {
    return { done: true, message: `请输入 1-${allResults.length} 的数字，或输入n查看下页，输入c取消` };
  }
  // 获取详情
  try {
    const selected = allResults[choice - 1];
    const platform = Object.values(PLATFORMS).find(p => p.name === selected.platform);
    if (!platform) return { done: true, message: '获取详情失败：无法找到平台处理器' };
    const detailId = selected.platform === 'MCMOD' ? selected.id : selected.extra.id;
    const detail = await platform.getDetail(ctx, detailId as any, config);
    if (!detail) return { done: true, message: '获取详情失败' };
    return { done: true, message: await renderOutput(session, detail.content, detail.url, ctx, config) };
  } catch (error) {
    ctx.logger.error(`获取详情发生异常:`, error);
    return { done: true, message: '获取详情时发生错误' };
  }
}

/**
 * 显示搜索结果页面
 */
async function displayResultPage(ctx, session, config, platformResults, currentPage, platforms, platformStates) {
  const allResults = mergeResults(platformResults);
  const resultsPerPage = config.searchResults;
  const startIndex = currentPage * resultsPerPage;
  const endIndex = startIndex + resultsPerPage;
  // 检查是否需要加载更多结果
  if (endIndex > allResults.length) {
    const activePlatforms = platforms.filter(p => !platformStates[p]?.exhausted);
    if (activePlatforms.length > 0 && allResults.length < endIndex) return { needMoreResults: true };
  }
  const currentResults = allResults.slice(startIndex, endIndex);
  if (currentResults.length === 0) return { message: '无更多结果' };
  // 计算总页数
  let totalPages = Math.ceil(allResults.length / resultsPerPage);
  // 如果只有一个平台且提供了总页数，使用平台自身的总页数
  if (platforms.length === 1 && platformStates[platforms[0]]?.totalPages > 0) totalPages = platformStates[platforms[0]].totalPages;
  // 渲染结果
  const formattedResults = [
    '请回复序号查看详情，输入n查看下页，输入c取消',
    ...currentResults.map((p, i) => {
      const index = startIndex + i + 1;
      const desc = config.searchDesc > 0 && p.description
        ? `\n  ${p.description.substring(0, config.searchDesc)}${p.description.length > config.searchDesc ? '...' : ''}`
        : '';
      return `${index}. [${p.platform}] ${p.name}${desc}`;
    }),
    ...(totalPages > 1 ? [`第 ${currentPage + 1}/${totalPages} 页`] : [])
  ];
  await renderOutput(session, formattedResults, null, ctx, config, false);
  return { success: true };
}

/**
 * 注册搜索命令
 */
export function registerSearch(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.search <keyword:string>', '搜索 Minecraft 资源')
    .option('platform', '-p <platform:string> 指定平台')
    .option('sort', '-s <sort:string> 排序方式')
    .option('version', '-v <version:string> 支持版本')
    .option('loader', '-l <loader:string> 加载器')
    .option('skip', '-k <count:number> 跳过结果数')
    .option('type', `-t <type:string> 资源类型(${Object.keys(CF_MAPS.TYPE).join('|')})`)
    .option('mrf', '-mrf <facets:string> [MR]高级过滤')
    .option('cfo', '-cfo <order:string> [CF]升降序')
    .option('what', '-ww <what:string> [Wiki]搜索范围')
    .option('mcmold', '-mm [Mod]复杂搜索')
    .option('download', '-d 下载模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '需要关键词';
      try {
        // 初始化搜索状态
        const platformResults = {};
        const platformStates = {};
        let currentPage = 0;
        const skip = Math.max(0, options.skip || 0);
        // 确定搜索平台
        const platformsResult = preparePlatforms(ctx, options);
        if (platformsResult.error) return platformsResult.error;
        const platforms = platformsResult.platformsToSearch;
        platforms.forEach(p => {
          platformResults[p] = [];
          platformStates[p] = { offset: skip, page: 1, totalPages: 1, totalResults: 0, exhausted: false };
        });
        // 初次搜索
        const initialSearch = await executeSearch(ctx, keyword, options, config, platforms, platformStates, platformResults);
        if (!initialSearch.success) return initialSearch.message;
        // 处理分页和用户交互
        while (true) {
          // 显示当前页
          const displayResult = await displayResultPage(ctx, session, config, platformResults, currentPage, platforms, platformStates);
          if (displayResult.message) return displayResult.message;
          // 如果需要加载更多结果
          if (displayResult.needMoreResults) {
            await executeSearch(ctx, keyword, options, config,
              platforms.filter(p => !platformStates[p]?.exhausted), platformStates, platformResults);
            continue;
          }
          // 等待用户输入
          const input = await session.prompt(60 * 1000);
          const userAction = await handleUserInput(
            input, mergeResults(platformResults), currentPage,
            config, ctx, session, platforms, platformStates,
            platformResults, options, keyword
          );
          if (userAction.done) return userAction.message;
          if (userAction.nextPage !== undefined) currentPage = userAction.nextPage;
        }
      } catch (error) {
        ctx.logger.error('搜索执行失败:', error);
        return '搜索过程中出错';
      }
    });
}