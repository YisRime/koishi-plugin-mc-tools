import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'
import { MCMOD_MAPS } from './maps'

/**
 * 处理MCMOD介绍文本，提取图片和分段
 * @param {string} body - 需要处理的MCMOD介绍文本
 * @param {number} paragraphLimit - 每段文本的最大长度限制
 * @returns {any[]} 处理后的内容数组，包含文本段落和图片元素
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

/**
 * 获取MCMOD API基础URL
 * @param {Config} config - 配置对象
 * @returns {string} 格式化后的API基础URL
 */
const getMcmodApiBase = (config: Config) =>
  typeof config?.mcmodEnabled === 'string' && config.mcmodEnabled.trim()
    ? (config.mcmodEnabled.trim().endsWith('/') ? config.mcmodEnabled.trim() : config.mcmodEnabled.trim() + '/')
    : ''

/**
 * 从映射表中获取值，如果不存在则返回默认值
 * @param {Record<string, any>} map - 映射表
 * @param {string} key - 查找的键
 * @param {string} defaultValue - 未找到时的默认值
 * @returns {any} 映射值或默认值
 */
const getMapValue = (map, key, defaultValue = `未知(${key})`) => map[key] || defaultValue

/**
 * 搜索MCMOD资源
 * @param {Context} ctx - Koishi上下文
 * @param {string} keyword - 搜索关键词
 * @param {Object} options - 搜索选项
 * @param {number} [options.page] - 页码
 * @param {number} [options.offset] - 偏移量
 * @param {number} [options.mold] - 搜索模式
 * @param {string} [options.type] - 资源类型
 * @param {Config} [config] - 配置对象
 * @returns {Promise<{results: Array<any>, pagination: Object}>} 搜索结果和分页信息
 */
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

/**
 * 获取MCMOD资源详情
 * @param {Context} ctx - Koishi上下文
 * @param {Object} project - 项目信息
 * @param {string} project.name - 项目名称
 * @param {string} project.url - 项目URL
 * @param {string} [project.description] - 项目描述
 * @param {boolean} [project.community] - 是否获取社区信息
 * @param {boolean} [project.relations] - 是否获取关联模组信息
 * @param {Object} [project.extra] - 额外信息
 * @param {Config} [config] - 配置对象
 * @returns {Promise<{content: Array<any>, url: string, icon: string|null}>} 处理后的项目详情
 */
export async function getMcmodProject(ctx: Context, project, config: Config = null) {
  try {
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
      versionInfo = ['forge', 'fabric', 'neoforge', 'quilt', 'behaviorPack', 'dataPack']
        .map(platform => compatibility.mcVersions[platform] &&
          `${ platform === 'behaviorPack' ? '行为包' : platform === 'dataPack' ? '数据包' :
            platform.charAt(0).toUpperCase() + platform.slice(1)
          }: ${compatibility.mcVersions[platform].join(', ')}`).filter(Boolean).join('\n● ')
    }
    // 获取模组状态
    const getModStatus = (status) => {
      if (!status) return '未知';
      switch (status.status) {
        case 'active': return '活跃';
        case 'semi-abandoned': return '半弃坑';
        case 'inactive': return '停更';
      }
    }
    // 构建完整内容
    const content = [
      basicInfo.img && h.image(basicInfo.img),
      [
        modName,
        `状态: ${[getModStatus(basicInfo.status), basicInfo.status?.isOpenSource ? '开源' : '闭源'].join(', ')}`,
        `分类: ${basicInfo.categories?.map(id => getMapValue(MCMOD_MAPS.MOD_CATEGORY, id)).join(', ') || '未知'}`,
        `标签: ${basicInfo.tags?.join(', ') || '无标签'}`,
        `作者: ${authors?.map(a => `${a.name}${a.position ? ` (${a.position})` : ''}`).join(', ') || '未知'}`,
        `支持平台: ${compatibility?.platforms?.join(', ') || '未知'}`,
        `运作方式: ${compatibility?.apis?.join(', ') || '未知'}`,
        `运行环境: ${compatibility?.environment || '未知'}`,
        `支持版本:\n● ${versionInfo}`,
        `Mod资料:\n${resources.map(res => `● ${getMapValue(MCMOD_MAPS.RESOURCE_TYPE, res.typeId)} (${res.count}条)`).join('\n')}`,
      ].join('\n'),
      links?.length && `相关链接:\n${links.slice(0, 10)
        .map(link => `● ${link.title}: ${link.url}`).join('\n')}`
    ].filter(Boolean)
    // 模组关系
    if (project.relations && relations?.length) {
      const relationItems = ['模组关系:']
      for (const relation of relations) {
        if (relation.version) {
          relationItems.push(`[${relation.version}]版本：`)
          if (relation.dependencyMods?.length) {
            relationItems.push(`  依赖模组: ${relation.dependencyMods.slice(0, 10)
              .map(mod => `[${mod.name}](https://www.mcmod.cn/class/${mod.id}.html)`).join(', ')}`)
          }
          if (relation.relationMods?.length) {
            relationItems.push(`  关联模组: ${relation.relationMods.slice(0, 10)
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
        content.push(community.tutorials.slice(0, 10)
          .map(t => `● [${t.title}](https://www.mcmod.cn/post/${t.id}.html)`).join('\n'))
      }
      if (community.discussions?.length) {
        content.push('Mod讨论:')
        content.push(community.discussions.slice(0, 10)
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
    return null
  }
}

/**
 * 获取MCMOD整合包详情
 * @param {Context} ctx - Koishi上下文
 * @param {Object} modpack - 整合包信息
 * @param {string} modpack.name - 整合包名称
 * @param {string} modpack.url - 整合包URL
 * @param {string} [modpack.description] - 整合包描述
 * @param {boolean} [modpack.community] - 是否获取社区信息
 * @param {boolean} [modpack.relations] - 是否获取关联模组信息
 * @param {Object} [modpack.extra] - 额外信息
 * @param {Config} [config] - 配置对象
 * @returns {Promise<{content: Array<any>, url: string, icon: string|null}>} 处理后的整合包详情
 */
export async function getMcmodModpack(ctx: Context, modpack, config: Config = null) {
  try {
    const response = await ctx.http.get(`${getMcmodApiBase(config)}api/modpack`, {
      params: { id: modpack.extra.id, others: false, community: modpack.community === true, relations: modpack.relations === true }
    })
    if (!response?.basicInfo) throw new Error('无法获取整合包详情')
    const { basicInfo, compatibility, links, authors, introduction, relations } = response
    // 整合包名称和基本信息
    const packName = [basicInfo.shortName, basicInfo.name, basicInfo.englishName ? `[${basicInfo.englishName}]` : null]
      .filter(Boolean).join(' ')
    // 构建完整内容
    const content = [
      basicInfo.img && h.image(basicInfo.img),
      [
        packName,
        `分类: ${basicInfo.categories?.map(id => getMapValue(MCMOD_MAPS.CATEGORY, id)).join(', ') || '未知'}`,
        `作者: ${authors?.map(a => `${a.name}${a.position ? ` (${a.position})` : ''}`).join(', ') || '未知'}`,
        compatibility?.packType && `整合包类型: ${compatibility.packType}`,
        compatibility?.apiType?.length ? `运作方式: ${compatibility.apiType.join(', ')}` : null,
        compatibility?.packMethod?.length ? `打包方式: ${compatibility.packMethod.join(', ')}` : null,
        compatibility?.mcVersions ? `支持版本: ${Array.isArray(compatibility.mcVersions) ? compatibility.mcVersions.join(', ') : '未知'}` : null,
      ].filter(Boolean).join('\n'),
      links?.length && `相关链接:\n${links.slice(0, 10)
        .map(link => `● ${link.title}: ${link.url}`).join('\n')}`
    ].filter(Boolean)
    // 包含模组
    if (modpack.relations && relations?.mods?.length) {
      content.push('包含模组:')
      content.push(relations.mods.slice(0, 10)
        .map(mod => `● [${mod.name}](https://www.mcmod.cn/class/${mod.id}.html)${mod.version ? ` (${mod.version})` : ''}`)
        .join('\n'))
    }
    // 相关教程
    if (modpack.community && relations?.tutorials?.length) {
      content.push('相关教程:')
      content.push(relations.tutorials.slice(0, 10)
        .map(t => `● [${t.title}](https://www.mcmod.cn/post/${t.id}.html)`)
        .join('\n'))
    }
    // 详细介绍
    if (introduction) {
      content.push(`详细介绍：`)
      const allIntroParts = processMcmodIntroduction(introduction, config.maxDescLength)
      const introParts = allIntroParts.slice(0, config.maxParagraphs)
      content.push(...introParts)
      if (introParts.length < allIntroParts.length) content.push('（更多内容请查看完整页面）')
    }
    content.push(`查看详情: ${modpack.url}`)
    return { content, url: modpack.url, icon: basicInfo.img || null }
  } catch (error) {
    ctx.logger.error('MCMOD 整合包获取失败:', error)
    return null
  }
}

/**
 * 获取MCMOD教程详情
 * @param {Context} ctx - Koishi上下文
 * @param {Object} post - 教程信息
 * @param {string} post.name - 教程标题
 * @param {string} post.url - 教程URL
 * @param {string} [post.description] - 教程描述
 * @param {boolean} [post.others] - 是否获取附加信息
 * @param {Object} [post.extra] - 额外信息
 * @param {Config} [config] - 配置对象
 * @returns {Promise<{content: Array<any>, url: string, icon: string|null}>} 处理后的教程详情
 */
export async function getMcmodPost(ctx: Context, post, config: Config = null) {
  try {
    const response = await ctx.http.get(`${getMcmodApiBase(config)}api/post`, {
      params: { id: post.extra.id, others: post.others === true }
    })
    if (!response?.content) throw new Error('无法获取教程详情')
    const { title, content, author, metrics } = response
    // 构建完整内容
    const postContent = [
      `教程：${title || post.name}`,
      post.others && author ? `作者：${author.name}` : null,
      post.others && metrics?.statistics ? `发布于：${new Date(metrics.statistics.createTime).toLocaleString('zh-CN')}` : null,
      post.others && metrics?.statistics?.viewCount ? `浏览量：${metrics.statistics.viewCount}` : null,
      `查看原文：${post.url}`
    ].filter(Boolean)
    // 处理教程内容
    if (content) {
      postContent.push(`\n内容预览：`)
      const allContentParts = processMcmodIntroduction(content, config.maxDescLength)
      const contentParts = allContentParts.slice(0, config.maxParagraphs)
      postContent.push(...contentParts)
      if (contentParts.length < allContentParts.length) postContent.push('（更多内容请查看完整页面）')
    }
    return { content: postContent, url: post.url, icon: post.others && author ? author.avatar : null }
  } catch (error) {
    ctx.logger.error('MCMOD 教程获取失败:', error)
    return null
  }
}

/**
 * 获取MCMOD物品详情
 * @param {Context} ctx - Koishi上下文
 * @param {Object} item - 物品信息
 * @param {string} item.name - 物品名称
 * @param {string} item.url - 物品URL
 * @param {string} [item.description] - 物品描述
 * @param {boolean} [item.others] - 是否获取附加信息
 * @param {Object} [item.extra] - 额外信息
 * @param {Config} [config] - 配置对象
 * @returns {Promise<{content: Array<any>, url: string, icon: string|null}>} 处理后的物品详情
 */
export async function getMcmodItem(ctx: Context, item, config: Config = null) {
  try {
    const response = await ctx.http.get(`${getMcmodApiBase(config)}api/item`, { params: { id: item.extra.id, others: item.others === true } })
    if (!response || !Array.isArray(response) || !response.length) throw new Error('无法获取物品详情')
    const itemContent = []
    let iconUrl = null
    // 处理每个物品
    for (let i = 0; i < response.length; i++) {
      const itemInfo = response[i]
      const { name, englishName, icon, command, category, introduction, properties, recipes } = itemInfo
      // 构建基本信息
      const itemElements = [
        icon && h.image(icon),
        [
          `${name}${englishName ? ` [${englishName}]` : ''}`,
          category && `分类：${category}`,
          ...(properties?.length ? properties.map(prop => `${prop.name}：${prop.value}`) : []),
          command && `获取：${command}`
        ].filter(Boolean).join('\n')
      ].filter(Boolean)
      itemContent.push(...itemElements)
      // 添加合成配方
      if (recipes?.length) {
        const recipesText = [`合成配方(${recipes.length}个)：`]
        for (let j = 0; j < recipes.length; j++) {
          const recipe = recipes[j]
          const recipeType = recipe.type || '未知类型'
          const materials = recipe.materials?.map(m => {
            const materialName = m.name || '未知原料'
            return m.count > 1 ? `${materialName} x${m.count}` : materialName
          }).join(', ') || '无原料信息'
          const result = recipe.result?.name || '未知产物'
          const resultCount = recipe.result?.count > 1 ? ` x${recipe.result.count}` : ''
          recipesText.push(`• 使用: ${recipeType}`)
          recipesText.push(`  原料: ${materials}`)
          recipesText.push(`  产物: ${result}${resultCount}`)
          if (recipe.notes) recipesText.push(`  备注: ${recipe.notes}`)
        }
        itemContent.push(recipesText.join('\n'))
      }
      // 添加物品介绍
      if (introduction) {
        itemContent.push(`物品介绍：`)
        const allIntroParts = processMcmodIntroduction(introduction, config.maxDescLength)
        const introParts = allIntroParts.slice(0, config.maxParagraphs)
        itemContent.push(...introParts)
        if (introParts.length < allIntroParts.length) itemContent.push('（更多内容请查看完整页面）')
      }
      // 添加相关内容
      if (item.others && itemInfo.teams?.relatedItems?.length) {
        const relatedItems = [`相关内容：`]
        itemInfo.teams.relatedItems.slice(0, 10).forEach(related => {
          relatedItems.push(`• [${related.name}](${related.url})`)
        })
        itemContent.push(relatedItems.join('\n'))
      }
    }
    itemContent.push(`查看详情: ${item.url}`)
    return { content: itemContent, url: item.url, icon: iconUrl }
  } catch (error) {
    ctx.logger.error('MCMOD 资料详情获取失败:', error)
    return null
  }
}

/**
 * 注册MCMOD相关命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} mc - 父命令
 * @param {Config} config - 配置对象
 */
export function registerMcmod(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.mod <keyword:string>', '查询 MCMOD 百科')
    .option('type', '-t <type:string> 资源类型')
    .option('mold', '-m 启用复杂搜索')
    .option('community', '-c 获取教程讨论')
    .option('relations', '-r 获取模组关系')
    .option('others', '-o 获取额外信息')
    .option('page', '-p <page:number> 页码')
    .option('shot', '-s 截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        const projects = await searchMcmodProjects(ctx, keyword, { type: options.type, mold: options.mold ? 1 : 0, page: options.page }, config)
        if (!projects.results.length) return '未找到匹配的资源'
        const project = projects.results[0]
        let projectInfo
        switch (project.type) {
          case 'class': // 模组
            projectInfo = await getMcmodProject(ctx, {
              name: project.name, url: project.url, description: project.description,
              community: options.community, relations: options.relations,
              extra: { id: project.id, type: project.type, category: project.category }
            }, config)
            break
          case 'modpack': // 整合包
            projectInfo = await getMcmodModpack(ctx, {
              name: project.name, url: project.url, description: project.description,
              community: options.community, relations: options.relations,
              extra: { id: project.id, type: project.type, category: project.category }
            }, config)
            break
          case 'post': // 教程
            projectInfo = await getMcmodPost(ctx, {
              name: project.name, url: project.url, description: project.description,
              others: options.others, extra: { id: project.id, type: project.type }
            }, config)
            break
          case 'item': // 物品
            projectInfo = await getMcmodItem(ctx, {
              name: project.name, url: project.url, description: project.description,
              others: options.others, extra: { id: project.id, type: project.type }
            }, config)
            break
          default: // 其他类型资源
            projectInfo = {
              content: [
                `[${project.name}]`,
                project.description || '暂无描述',
                `类型: ${getMapValue(MCMOD_MAPS.TYPE, project.type, '未知')}`,
                `查看详情: ${project.url}`
              ].filter(Boolean),
              url: project.url,
              icon: null
            }
        }
        const result = await renderOutput(session, projectInfo.content, projectInfo.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('MCMOD 查询失败:', error)
        return '查询时出错'
      }
    })
}
