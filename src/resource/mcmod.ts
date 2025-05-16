import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { MCMOD_MAPS } from './maps'

/**
 * 处理MCMOD介绍文本，提取图片和分段
 */
function processMcmodIntroduction(body: string, paragraphLimit: number): any[] {
  const result = []
  body = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // 提取所有图片
  const images = []
  let match
  const imgRegex = /!\[((?:\[[^\]]*\]|[^\]])*)\]\(([^)]+)\)/g
  while ((match = imgRegex.exec(body)) !== null) {
    images.push({ index: match.index, length: match[0].length, url: match[2], text: match[0] })
  }
  // 处理段落
  const processParagraphs = (text, startBuffer = '') => {
    let buffer = startBuffer
    for (const para of text.split('\n\n').filter(p => p.trim())) {
      const isHeading = /^#{1,6}\s/.test(para.trim())
      if ((isHeading && buffer) || (buffer && buffer.length + para.length + 2 > paragraphLimit)) {
        result.push(buffer)
        buffer = para
      } else {
        buffer = buffer ? `${buffer}\n${para}` : para
      }
    }
    return buffer
  }
  // 无图片时直接处理文本
  if (!images.length) {
    const finalBuffer = processParagraphs(body)
    if (finalBuffer) result.push(finalBuffer)
    return result;
  }
  // 有图片时处理图文混合内容
  let lastIndex = 0, contentBuffer = ''
  for (let i = 0; i < images.length; i++) {
    const image = images[i]
    // 处理图片前文本
    if (image.index > lastIndex) {
      contentBuffer = processParagraphs(body.substring(lastIndex, image.index).trim(), contentBuffer)
      if (contentBuffer) {
        result.push(contentBuffer)
        contentBuffer = ''
      }
    }
    // 添加图片
    result.push(h.image(image.url))
    lastIndex = image.index + image.length
    // 处理图片间描述文本
    if (i < images.length - 1) {
      const nextImage = images[i + 1]
      const textBetween = body.substring(lastIndex, nextImage.index).trim()
      if (textBetween && (textBetween.length < paragraphLimit / 2 || !textBetween.includes('\n\n'))) {
        result.push(textBetween)
        lastIndex = nextImage.index
      }
    }
  }
  // 处理最后一个图片后的文本
  contentBuffer = processParagraphs(body.substring(lastIndex).trim(), contentBuffer)
  if (contentBuffer) result.push(contentBuffer)
  return result
}

// 获取MCMOD API基础URL
const getMcmodApiBase = (config: Config) =>
  typeof config?.mcmodEnabled === 'string' && config.mcmodEnabled.trim()
    ? (config.mcmodEnabled.trim().endsWith('/') ? config.mcmodEnabled.trim() : config.mcmodEnabled.trim() + '/')
    : ''
// 获取映射值
const getMapValue = (map, key, defaultValue = `未知(${key})`) => map[key] || defaultValue

// 搜索MCMOD资源
export async function searchMcmodProjects(ctx: Context, keyword: string, options = {}, config: Config = null) {
  try {
    const pageSize = 30
    const page = options['page'] || (options['offset'] ? Math.floor(options['offset'] / pageSize) + 1 : 1)
    const params = {
      q: keyword, page,
      ...(options['mold'] === 1 || options['mcmold'] ? { mold: 1 } : {}),
      ...(options['type'] && MCMOD_MAPS.FILTER[options['type']] > 0 ?
          { filter: MCMOD_MAPS.FILTER[options['type']] } : {})
    }
    const response = await ctx.http.get(`${getMcmodApiBase(config)}api/search`, { params })
    if (response?.results?.length) {
      return {
        results: response.results.map(({ id, name, description, type, url, category }) =>
          ({ id, name, description, type, url, category })),
        pagination: {
          page: response.page || 1, total: response.total || 1,
          totalResults: response.totalResults || response.results.length,
          pageSize, offset: (response.page - 1) * pageSize
        }
      }
    }
    return { results: [], pagination: { page: 1, total: 0, totalResults: 0, pageSize, offset: 0 } }
  } catch (error) {
    ctx.logger.error('MCMOD 搜索失败:', error)
    return { results: [], pagination: { page: 1, total: 0, totalResults: 0, pageSize: 0, offset: 0 } }
  }
}

// 处理MCMOD资源详情
export async function getMcmodProject(ctx: Context, project, config: Config = null) {
  try {
    // 构建基本内容
    const basicContent = [
      `[${project.name}]`, project.description || '暂无描述',
      project.extra?.type === 'class' ? null : `类型: ${getMapValue(MCMOD_MAPS.TYPE, project.extra?.type, '未知')}`,
      `查看详情: ${project.url}`
    ].filter(Boolean)
    // 非模组类型直接返回基本信息
    if (project.extra?.type !== 'class') return { content: basicContent, url: project.url, icon: null }
    // 获取模组详情
    const response = await ctx.http.get(`${getMcmodApiBase(config)}api/class`, {
      params: { id: project.extra.id, others: false, community: project.community === true, relations: project.relations === true }
    })
    if (!response?.basicInfo) throw new Error('无法获取模组详情')
    const { basicInfo, compatibility, links, authors, resources, introduction, community, relations } = response
    // 模组名称和基本信息
    const modName = [basicInfo.shortName, basicInfo.name, basicInfo.englishName ? `[${basicInfo.englishName}]` : null]
      .filter(Boolean).join(' ')
    // 版本信息
    let versionInfo = '未知'
    if (compatibility?.mcVersions) {
      versionInfo = ['forge', 'fabric', 'behaviorPack']
        .map(platform => compatibility.mcVersions[platform] &&
          `${platform === 'behaviorPack' ? '行为包' : platform.charAt(0).toUpperCase() + platform.slice(1)}: ${compatibility.mcVersions[platform].join(', ')}`)
        .filter(Boolean).join('\n● ')
    }
    // 构建完整内容
    const content = [
      basicInfo.img && h.image(basicInfo.img),
      [
        modName,
        `状态: ${[basicInfo.status?.isActive ? '活跃' : '停更', basicInfo.status?.isOpenSource ? '开源' : '闭源'].join(', ')}`,
        `分类: ${basicInfo.categories?.map(id => getMapValue(MCMOD_MAPS.CATEGORY, id)).join(', ') || '未知'}`,
        `标签: ${basicInfo.tags?.join(', ') || '无标签'}`,
        `作者: ${authors?.map(a => `${a.name}${a.position ? ` (${a.position})` : ''}`).join(', ') || '未知'}`,
        `支持平台: ${compatibility?.platforms?.join(', ') || '未知'}`,
        `运作方式: ${compatibility?.apis?.join(', ') || '未知'}`,
        `运行环境: ${compatibility?.environment || '未知'}`,
        `支持版本:\n● ${versionInfo}`,
        `Mod资料:\n${resources.map(res => `● ${getMapValue(MCMOD_MAPS.RESOURCE_TYPE, res.typeId)} (${res.count}条)`).join('\n')}`,
      ].join('\n'),
      links?.length && `相关链接:\n${links.slice(0, config.maxModLinks)
        .map(link => `● ${link.title}: ${link.url}`).join('\n')}`
    ].filter(Boolean)
    // 模组关系
    if (project.relations && relations?.length) {
      const relationItems = ['模组关系:']
      for (const relation of relations) {
        if (relation.version) {
          relationItems.push(`[${relation.version}]版本：`)
          if (relation.dependencyMods?.length) {
            relationItems.push(`  依赖模组: ${relation.dependencyMods.slice(0, config.maxModLinks)
              .map(mod => `[${mod.name}](https://www.mcmod.cn/class/${mod.id}.html)`).join(', ')}`)
          }
          if (relation.relationMods?.length) {
            relationItems.push(`  关联模组: ${relation.relationMods.slice(0, config.maxModLinks)
              .map(mod => `[${mod.name}](https://www.mcmod.cn/class/${mod.id}.html)`).join(', ')}`)
          }
        }
      }
      if (relationItems.length > 1) content.push(relationItems.join('\n'))
    }
    // Mod教程和讨论
    if (community) {
      if (community.tutorials?.length) {
        content.push('Mod教程:')
        content.push(community.tutorials.slice(0, config.maxModLinks)
          .map(t => `● [${t.title}](https://www.mcmod.cn/post/${t.id}.html)`).join('\n'))
      }
      if (community.discussions?.length) {
        content.push('Mod讨论:')
        content.push(community.discussions.slice(0, config.maxModLinks)
          .map(d => `● [${d.title}](https://bbs.mcmod.cn/thread-${d.id}-1-1.html)`).join('\n'))
      }
    }
    // 处理详细介绍
    if (introduction) {
      content.push(`详细介绍：`)
      const allIntroParts = processMcmodIntroduction(introduction, config.maxDescLength)
      const introParts = allIntroParts.slice(0, config.maxParagraphs)
      content.push(...introParts)
      if (introParts.length < allIntroParts.length) content.push('（更多内容请查看完整页面）')
    }
    content.push(`查看详情: ${project.url}`)
    return { content, url: project.url, icon: basicInfo.img || null }
  } catch (error) {
    ctx.logger.error('MCMOD 详情获取失败:', error)
    return { content: [ `[${project.name}]`, project.description || '暂无描述', `查看详情: ${project.url}` ], url: project.url, icon: null }
  }
}

// 注册 mcmod 命令
export function registerMcmod(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.mod <keyword:string>', '查询 MCMOD 百科')
    .option('type', '-t <type:string> 资源类型')
    .option('mold', '-m 启用复杂搜索')
    .option('community', '-c 获取教程讨论')
    .option('relations', '-r 获取模组关系')
    .option('page', '-p <page:number> 页码')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        const projects = await searchMcmodProjects(ctx, keyword, { type: options.type, mold: options.mold ? 1 : 0, page: options.page }, config)
        if (!projects.results.length) return '未找到匹配的资源'
        const project = projects.results[0]
        const projectInfo = await getMcmodProject(ctx, {
          name: project.name, url: project.url, description: project.description,
          community: options.community, relations: options.relations,
          extra: { id: project.id, type: project.type, category: project.category }
        }, config)
        const result = await renderOutput(session, projectInfo.content, projectInfo.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('MCMOD 查询失败:', error)
        return '查询时出错'
      }
    })
}