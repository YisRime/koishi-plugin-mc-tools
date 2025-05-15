import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { STATUS_MAP } from './maps'

/** Modrinth API基础URL */
const MR_API_BASE = 'https://api.modrinth.com/v2'

/**
 * 解析Facets字符串为适当的格式
 * @param {string} facetsStr - 要解析的facets字符串
 * @returns {string[][]} 解析后的facets数组
 */
function parseFacets(facetsStr: string): string[][] {
  if (!facetsStr) return []
  try {
    return facetsStr.startsWith('[') && facetsStr.endsWith(']')
      ? JSON.parse(facetsStr)
      : facetsStr.split(',').map(facet => {
          const parts = facet.trim().split(':')
          return parts.length >= 2
            ? [parts.length === 2 ? `${parts[0]}:${parts[1]}` : `${parts[0]}${parts[1]}${parts[2]}`]
            : [facet.trim()]
        })
  } catch {
    return []
  }
}

/**
 * 在Modrinth搜索项目
 * @param {Context} ctx - Koishi上下文
 * @param {string} keyword - 搜索关键词
 * @param {Object} options - 搜索选项
 * @returns {Promise<Array>} 搜索结果
 */
export async function searchModrinthProjects(ctx: Context, keyword: string, options = {}) {
  try {
    const { facets, sort, offset, limit, ...otherOptions } = options as any
    const params = {
      query: keyword, ...(sort && { index: sort }),
      ...(offset !== undefined && { offset: offset }),
      ...(limit !== undefined && { limit: limit }),
      ...Object.fromEntries(Object.entries(otherOptions).filter(([_, v]) => v !== undefined))
    }
    if (facets) params['facets'] = JSON.stringify(parseFacets(facets))
    const response = await ctx.http.get(`${MR_API_BASE}/search`, { params })
    return response.hits || []
  } catch (error) {
    ctx.logger.error('Modrinth 搜索失败:', error)
    return []
  }
}

/**
 * 将长文本分割成适当长度的段落
 * @param text 要处理的文本
 * @param paragraphLimit 段落字数限制
 * @returns 分段后的文本数组
 */
function splitIntoParagraphs(text: string, paragraphLimit: number): string[] {
  const result: string[] = []
  if (text.length <= paragraphLimit) {
    result.push(text)
    return result
  }
  const sentenceBreaks = text.match(/[。！？\.!?]+/g)
  if (sentenceBreaks?.length > 5) {
    // 按句子分段
    let subParagraph = ''
    for (const sentence of text.split(/(?<=[。！？\.!?]+)/)) {
      if ((subParagraph + sentence).length > paragraphLimit) {
        if (subParagraph.trim()) result.push(subParagraph.trim())
        subParagraph = sentence
      } else {
        subParagraph += sentence
      }
    }
    if (subParagraph.trim()) result.push(subParagraph.trim())
  } else {
    // 按字符数分段
    for (let j = 0; j < text.length; j += paragraphLimit) {
      result.push(text.substring(j, Math.min(j + paragraphLimit, text.length)).trim())
    }
  }
  return result
}

/**
 * 处理Modrinth项目描述文本，进行分段
 * @param body 项目描述原始文本
 * @param paragraphLimit 段落字数限制
 * @returns 分段后的字符串数组
 */
function processModrinthBody(body: string, paragraphLimit: number): string[] {
  const images: string[] = []
  // 提取所有img标签的URL
  body = body.replace(/<img\s+src="([^"]+)"(?:\s+alt="[^"]*")?\s*\/?>/g, (match, url) => {
    images.push(url)
    return `__IMAGE__${images.length - 1}__`
  })
  // 处理其他HTML标签
  body = body
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/g, '$1')
    .replace(/<center>([\s\S]*?)<\/center>/g, '$1')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '$1\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // 规范化文本
  const normalizedText = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  const paragraphs = normalizedText.split('\n\n')
  const result: string[] = []
  // 处理段落
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue
    // 检查是否是图片占位符
    const imageMatch = paragraph.trim().match(/^__IMAGE__(\d+)__$/)
    if (imageMatch) {
      const imageIndex = parseInt(imageMatch[1])
      if (!isNaN(imageIndex) && imageIndex >= 0 && imageIndex < images.length) result.push(`__IMAGE__${images[imageIndex]}__`)
      continue
    }
    // 处理普通文本
    const cleanParagraph = paragraph
      .replace(/[#\-*]/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
      .replace(/__IMAGE__\d+__/g, '')
    if (!cleanParagraph.trim()) continue
    result.push(...splitIntoParagraphs(cleanParagraph.trim(), paragraphLimit))
  }
  return result
}

/**
 * 获取Modrinth项目详情
 * @param {Context} ctx - Koishi上下文
 * @param {string} projectId - 项目ID
 * @param {Config} config - 配置对象
 * @returns {Promise<Object|null>} 项目详情，包含content和url
 */
export async function getModrinthProject(ctx: Context, projectId: string, config: Config) {
  try {
    const project = await ctx.http.get(`${MR_API_BASE}/project/${projectId}`)
    if (!project) return null
    const projectUrl = `https://modrinth.com/${project.project_type}/${project.slug}`
    const formatDate = date => date ? new Date(date).toLocaleString() : '未知'
    // 构建内容
    const content = [
      project.icon_url && h.image(project.icon_url),
      `[${project.title}]\n${project.description}`,
      // 详细信息
      [
        `分类: ${project.categories?.join(', ')}`,
        project.additional_categories?.length ? `子分类: ${project.additional_categories.join(', ')}` : null,
        `类型: ${(STATUS_MAP.type && STATUS_MAP.type[project.project_type]) || project.project_type}`,
        `加载器: ${project.loaders?.join(', ')}`,
        `客户端: ${(STATUS_MAP.compatibility && STATUS_MAP.compatibility[project.client_side]) || project.client_side} 服务端: ${(STATUS_MAP.compatibility && STATUS_MAP.compatibility[project.server_side]) || project.server_side}`,
        `支持版本: ${project.game_versions?.join(', ')}`,
        `更新于: ${formatDate(project.updated)}`,
        `下载量: ${project.downloads?.toLocaleString()}`,
        `许可: ${project.license?.id}${project.license?.name ? ` (${project.license.name})` : ''}`
      ].filter(Boolean).map(item => `● ${item}`).join('\n')
    ].filter(Boolean)
    // 相关链接
    const links = [
      project.source_url && `源代码: ${project.source_url}`,
      project.issues_url && `问题追踪: ${project.issues_url}`,
      project.wiki_url && `Wiki: ${project.wiki_url}`,
      project.discord_url && `Discord: ${project.discord_url}`,
      ...(project.donation_urls?.map(d =>
        `赞助 (${d.platform}): ${d.url}`
      ) || [])
    ].filter(Boolean)
    if (links.length > 0) content.push(`相关链接：\n${links.join('\n')}`)
    // 图库
    if (project.gallery?.length > 0) {
      content.push(`图库：`)
      project.gallery.slice(0, 3).forEach(img => {content.push(h.image(img.url))})
    }
    // 详细介绍
    if (project.body) {
      content.push(`详细介绍：`)
      const bodyParts = processModrinthBody(project.body, config.maxDescLength).slice(0, config.maxParagraphs)
      // 处理详细介绍中的图片标记
      content.push(...bodyParts.map(part => {
        const imageMatch = part.match(/^__IMAGE__(.+)__$/)
        if (imageMatch) return h.image(imageMatch[1])
        return part
      }))
      if (processModrinthBody(project.body, config.maxDescLength).length > config.maxParagraphs) {
        content.push('（更多内容请查看完整页面）')
      }
    }
    // 项目地址
    content.push(`项目地址：${projectUrl}`)
    return { content, url: projectUrl }
  } catch (error) {
    ctx.logger.error('Modrinth 详情获取失败:', error)
    return null
  }
}

/**
 * 注册Modrinth命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令对象
 * @param {Config} config - 配置对象
 */
export function registerModrinth(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.modrinth <keyword:string>', '查询 Modrinth 资源')
    .option('type', '-t <type:string> 资源类型')
    .option('version', '-v <version:string> 支持版本')
    .option('facets', '-f <facets:string> 高级过滤')
    .option('sort', '-sort <sort:string> 排序方式')
    .option('skip', '-k <count:number> 跳过结果数')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        const searchOptions = { sort: options.sort, offset: Math.max(0, options.skip || 0), limit: 1 }
        const facetsArray = []
        if (options.type) facetsArray.push([`project_type:${options.type}`])
        if (options.version) facetsArray.push([`versions:${options.version}`])
        if (options.facets) facetsArray.push(...parseFacets(options.facets))
        if (facetsArray.length) searchOptions['facets'] = JSON.stringify(facetsArray)
        const projects = await searchModrinthProjects(ctx, keyword, searchOptions)
        if (!projects.length) return '未找到匹配的资源'
        const projectInfo = await getModrinthProject(ctx, projects[0].project_id, config)
        if (!projectInfo) return '获取详情失败'
        const result = await renderOutput(session, projectInfo.content, projectInfo.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('Modrinth 查询失败:', error)
        return '查询时出错'
      }
    })
}