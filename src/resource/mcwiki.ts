import { Context, Command, h } from 'koishi'
import { Config } from '../index'
import { renderOutput } from './render'

/** Minecraft Wiki API基础URL */
const WIKI_API_BASE = 'https://zh.minecraft.wiki/api.php'

/**
 * 搜索Minecraft Wiki页面
 * @param ctx Koishi上下文
 * @param keyword 搜索关键词
 * @param options 搜索选项，可包含offset和what参数
 * @returns 搜索结果数组，失败则返回空数组
 */
export async function searchMcwikiPages(ctx: Context, keyword: string, options: Record<string, any> = {}) {
  try {
    const { offset = 0, what } = options;
    const sroffset = Number(offset);
    // 构建API参数
    const params: Record<string, any> = { action: 'query', list: 'search', srsearch: keyword, format: 'json' };
    if (sroffset > 0) params.sroffset = sroffset;
    if (what) params.srwhat = what;
    // 执行API请求
    const response = await ctx.http.get(WIKI_API_BASE, { params });
    const results = response.query?.search || [];
    const searchInfo = response.query?.searchinfo || {};
    const continueInfo = response.continue || {};
    return { results,
      pagination: {
        totalResults: searchInfo.totalhits || 0, offset: sroffset,
        nextOffset: continueInfo.sroffset ? Number(continueInfo.sroffset) : undefined,
        exhausted: results.length === 0 || !continueInfo.sroffset
      }
    };
  } catch (error) {
    ctx.logger.error('Minecraft Wiki 搜索失败:', error);
    return { results: [], pagination: { totalResults: 0, offset: Number(options.offset || 0), exhausted: true } };
  }
}

/**
 * 获取Minecraft Wiki页面详情
 * @param ctx Koishi上下文
 * @param pageId 页面ID
 * @param config 配置对象
 * @returns 包含页面内容、URL和图标URL的对象，获取失败则返回null
 */
export async function getMcwikiPage(ctx: Context, pageId: number, config: Config) {
  try {
    const response = await ctx.http.get(WIKI_API_BASE, {
      params: {
        action: 'query', pageids: pageId, prop: 'info|extracts|images',
        inprop: 'url', explaintext: true, format: 'json'
      }
    })
    const page = response.query?.pages?.[pageId]
    if (!page) return null
    // 获取第一张图片
    let imageUrl = null
    if (page.images?.length > 0) {
      try {
        const imgResponse = await ctx.http.get(WIKI_API_BASE, {
          params: {
            action: 'query', titles: page.images[0].title,
            prop: 'imageinfo', iiprop: 'url', format: 'json'
          }
        })
        const imgPages = imgResponse.query?.pages
        imageUrl = imgPages?.[Object.keys(imgPages || {})[0]]?.imageinfo?.[0]?.url
      } catch (error) {
        ctx.logger.error('Minecraft Wiki 图片获取失败:', error)
      }
    }
    // 处理提取的正文内容
    const extractContent = page.extract
      ? processWikiExtract(page.extract, config.maxDescLength).slice(0, config.maxParagraphs)
      : []
    if (page.extract && processWikiExtract(page.extract, config.maxDescLength).length > config.maxParagraphs) extractContent.push('（更多内容请查看完整页面）')
    // 构建内容
    const content = [
      imageUrl && h.image(imageUrl),
      extractContent.length > 0 ? `[${page.title}]\n${extractContent[0]}` : `[${page.title}]`,
      ...extractContent.slice(1),
      `完整页面: ${page.fullurl}`
    ].filter(Boolean)
    return { content, url: page.fullurl, icon: imageUrl }
  } catch (error) {
    ctx.logger.error('Minecraft Wiki 详情获取失败:', error)
    return null
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
 * 处理Wiki提取的内容，进行分段
 * @param extract Wiki提取的原始文本
 * @param paragraphLimit 段落字数限制
 * @returns 分段后的字符串数组
 */
function processWikiExtract(extract: string, paragraphLimit: number): string[] {
  const normalizedText = extract.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  const paragraphs = normalizedText.split('\n\n')
  const result: string[] = []
  let currentSection = ''
  let lastSectionType = 'none'
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue
    const isHeading = /^==+ .+ ==+$/.test(paragraph)
    const isSubHeading = /^=== .+ ===$/.test(paragraph)
    // 保存累积的内容
    const saveCurrentSection = () => {
      if (currentSection) {
        result.push(currentSection.trim())
        currentSection = ''
      }
    }
    if (isHeading) {
      saveCurrentSection()
      result.push(paragraph)
      lastSectionType = 'heading'
    } else if (isSubHeading) {
      saveCurrentSection()
      currentSection = paragraph
      lastSectionType = 'subheading'
    } else if (paragraph.length > paragraphLimit) {
      saveCurrentSection()
      // 处理超长段落
      result.push(...splitIntoParagraphs(paragraph, paragraphLimit))
      lastSectionType = 'content'
    } else if (lastSectionType === 'subheading') {
      currentSection += '\n' + paragraph
      lastSectionType = 'content'
    } else {
      saveCurrentSection()
      currentSection = paragraph
      lastSectionType = 'content'
    }
  }
  if (currentSection) result.push(currentSection.trim())
  return result
}

/**
 * 注册mcwiki命令
 * @param ctx Koishi上下文
 * @param mc 命令对象
 * @param config 机器人配置
 */
export function registerMcwiki(ctx: Context, mc: Command, config: Config) {
  mc.subcommand('.wiki <keyword:string>', '查询 Minecraft Wiki')
    .option('skip', '-k <count:number> 跳过结果数')
    .option('what', '-w <what:string> 搜索范围')
    .option('exact', '-e 精确匹配')
    .option('shot', '-s 使用截图模式')
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入关键词'
      try {
        const searchKey = options.exact ? `"${keyword}"` : keyword
        const searchOptions = { offset: Math.max(0, options.skip || 0), what: options.what }
        const { results: pages, pagination } = await searchMcwikiPages(ctx, searchKey, searchOptions)
        if (!pages.length) return '未找到匹配的条目'
        const pageInfo = await getMcwikiPage(ctx, pages[0].pageid, config)
        if (!pageInfo) return '获取详情失败'
        const result = await renderOutput(session, pageInfo.content, pageInfo.url, ctx, config, options.shot)
        return config.useForward && result === '' && !options.shot ? undefined : result
      } catch (error) {
        ctx.logger.error('Minecraft Wiki 查询失败:', error)
        return '查询时出错'
      }
    })
}