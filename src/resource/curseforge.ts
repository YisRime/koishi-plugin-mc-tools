import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { CF_MAPS } from './maps'
import { handleDownload } from './download'

/** CurseForge API基础URL */
const CF_API_BASE = 'https://api.curseforge.com/v1'

/**
 * 搜索CurseForge项目
 * @param {Context} ctx - Koishi上下文
 * @param {string} keyword - 搜索关键词
 * @param {string} api - API密钥
 * @param {Object} options - 搜索选项
 * @returns {Promise<Object>} 搜索结果和分页信息
 */
export async function searchCurseForgeProjects(ctx: Context, keyword: string, api: string, options = {}) {
  try {
    if (!api) return { results: [], pagination: { totalCount: 0 } }
    const params = { gameId: 432, searchFilter: keyword, sortOrder: options['sortOrder'] || 'desc' }
    // 处理搜索参数
    const validParams = [
      'categoryId', 'classId', 'gameVersion', 'modLoaderType',
      'gameVersionTypeId', 'authorId', 'primaryAuthorId',
      'slug', 'categoryIds', 'gameVersions',
      'modLoaderTypes', 'sortField', 'pageSize', 'index'
    ]
    validParams.forEach(param => {
      if (options[param] === undefined) return
      if (Array.isArray(options[param])) {
        params[param] = options[param].join(',')
      } else if (typeof options[param] === 'string' &&
        (param === 'categoryIds' || param === 'gameVersions' || param === 'modLoaderTypes')) {
        try {
          const parsed = JSON.parse(options[param])
          params[param] = Array.isArray(parsed) ? parsed.join(',') : options[param]
        } catch {
          params[param] = options[param]
        }
      } else {
        params[param] = options[param]
      }
    })
    const response = await ctx.http.get(`${CF_API_BASE}/mods/search`, { headers: { 'x-api-key': api }, params })
    return { results: response.data || [], pagination: response.pagination || { totalCount: 0 } }
  } catch (error) {
    ctx.logger.error('CurseForge 搜索失败:', error)
    return { results: [], pagination: { totalCount: 0 } }
  }
}

/**
 * 获取CurseForge项目详情
 * @param {Context} ctx - Koishi上下文
 * @param {number} projectId - 项目ID
 * @param {string} api - API密钥
 * @returns {Promise<Object|null>} 项目详情，包含content和url
 */
export async function getCurseForgeProject(ctx: Context, projectId: number, api: string) {
  try {
    if (!api) return null
    const projectRes = await ctx.http.get(`${CF_API_BASE}/mods/${projectId}`, { headers: { 'x-api-key': api } })
    const project = projectRes.data
    if (!project) return null
    const formatDate = date => new Date(date).toLocaleString()
    // 构建内容
    const content = [
      project.logo.url && h.image(project.logo.url), `[${project.name}]\n${project.summary}`,
      // 基本信息
      [
        `分类: ${project.categories?.map(c => c.name).join(', ')}`,
        `加载器: ${project.latestFilesIndexes?.map(f => { return Object.entries(CF_MAPS.LOADER)
            .find(([_, val]) => val === f.modLoader)?.[0] || f.modLoader;
        }).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
        `支持版本: ${project.latestFilesIndexes?.map(f => f.gameVersion)
          .filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
        `作者: ${project.authors.map(a => a.name).join(', ')}`,
        `更新于: ${formatDate(project.dateModified)}`,
        `下载量: ${project.downloadCount.toLocaleString()}`
      ].filter(Boolean).map(item => `● ${item}`).join('\n'),
    ].filter(Boolean)
    // 相关链接
    const links = [
      project.links?.websiteUrl && `官方网站: ${project.links.websiteUrl}`,
      project.links?.wikiUrl && `Wiki: ${project.links.wikiUrl}`,
      project.links?.issuesUrl && `问题追踪: ${project.links.issuesUrl}`,
      project.links?.sourceUrl && `源代码: ${project.links.sourceUrl}`
    ].filter(Boolean)
    if (links.length > 0) content.push(`相关链接：\n${links.join('\n')}`)
    // 图库
    if (project.screenshots?.length) {
      content.push('图库：')
      project.screenshots.slice(0, 3).forEach(s => {content.push(h.image(s.url))})
    }
    // 项目地址
    content.push(`项目地址：${project.links.websiteUrl}`)
    return { content, url: project.links.websiteUrl }
  } catch (error) {
    ctx.logger.error('CurseForge 详情获取失败:', error)
    return null
  }
}

/**
 * 注册CurseForge命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令对象
 * @param {Config} config - 配置对象
 */
export function registerCurseForge(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.curseforge <keyword:string>', `查询 CurseForge 资源`)
    .option('type', `-t <type:string> 资源类型(${Object.keys(CF_MAPS.TYPE).join('|')})`)
    .option('version', '-v <version:string> 支持版本')
    .option('loader', '-l <loader:string> 加载器')
    .option('skip', '-k <count:number> 跳过结果数')
    .option('shot', '-s 截图模式')
    .option('download', '-d 下载模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      if (!config.curseforgeEnabled) return '未配置 CurseForge API 密钥'
      try {
        const searchOptions = {
          categoryId: options.type ? CF_MAPS.TYPE[options.type] : undefined,
          gameVersion: options.version, index: Math.max(0, options.skip || 0), pageSize: 1,
          modLoaderType: options.loader ? CF_MAPS.LOADER[options.loader] : undefined,
        }
        const { results } = await searchCurseForgeProjects(ctx, keyword, config.curseforgeEnabled, searchOptions)
        if (!results.length) return '未找到匹配的资源'
        if (options.download) return handleDownload(ctx, session, 'curseforge', results[0], config, options)
        const projectInfo = await getCurseForgeProject(ctx, results[0].id, config.curseforgeEnabled)
        if (!projectInfo) return '获取详情失败'
        const result = await renderOutput(session, projectInfo.content, projectInfo.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('CurseForge 查询失败:', error)
        return '查询时出错'
      }
    })
}