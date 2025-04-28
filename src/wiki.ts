import { Context } from 'koishi'
import * as cheerio from 'cheerio'
import axios from 'axios'
import { MTConfig, LangCode } from './index'
import { capture } from './shot'

export interface SearchResult {
  title: string
  url: string
  desc?: string
  source: 'wiki' | 'mcmod'
}

/**
 * 获取语言变体
 * @param {LangCode | string} languageCode - 语言代码
 * @returns {string} 语言变体
 */
function getLanguageVariant(languageCode: LangCode | string): string {
  if (!languageCode.startsWith('zh')) return '';
  return languageCode === 'zh' ? 'zh-cn' :
         languageCode === 'zh-hk' ? 'zh-hk' :
         languageCode === 'zh-tw' ? 'zh-tw' : 'zh-cn';
}

/**
 * 构建 Wiki URL
 * @param {string} articleTitle - 文章标题
 * @param {LangCode | string} languageCode - 语言代码
 * @param {boolean} includeLanguageVariant - 是否包含语言变体参数
 * @returns {string} 构建好的 Wiki URL
 */
function buildUrl(articleTitle: string, languageCode: LangCode | string, includeLanguageVariant = false) {
  const cleanTitle = articleTitle.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  const wikiDomain = languageCode.startsWith('zh') ? 'zh.minecraft.wiki' :
                     (languageCode === 'en' ? 'minecraft.wiki' : `${languageCode}.minecraft.wiki`);
  const languageVariant = getLanguageVariant(languageCode);
  try {
    const encodedTitle = encodeURIComponent(cleanTitle);
    const baseUrl = `https://${wikiDomain}/w/${encodedTitle}`;
    return includeLanguageVariant && languageVariant ? `${baseUrl}?variant=${languageVariant}` : baseUrl;
  } catch (error) {
    const safeTitle = cleanTitle.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const baseUrl = `https://${wikiDomain}/w/${safeTitle}`;
    return includeLanguageVariant && languageVariant ? `${baseUrl}?variant=${languageVariant}` : baseUrl;
  }
}

/**
 * Wiki 搜索
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 * @throws {Error} 搜索失败时抛出错误
 */
async function searchWiki(keyword: string, _config?: any): Promise<SearchResult[]> {
  try {
    const searchUrl = buildUrl('api.php', 'zh', true).replace('/w/', '/')
      + `&action=opensearch&search=${encodeURIComponent(keyword)}&limit=10`;
    const { data } = await axios.get(searchUrl, {
      timeout: 30000
    });
    const [_, titles, urls] = data;
    if (!titles?.length) return [];
    return titles.map((title, i) => ({ title, url: urls[i], source: 'wiki' }));
  } catch (error) {
    throw new Error(`搜索出错：${error.message}`);
  }
}

/**
 * 获取 Wiki 文章内容
 * @param {string} articleUrl - 文章URL
 * @param {LangCode} languageCode - 语言代码
 * @param {MTConfig} config - 插件配置
 * @returns {Promise<{title: string, content: string, url: string}>}
 */
async function fetchContent(articleUrl: string, languageCode: LangCode, config: MTConfig) {
  try {
    const languageVariant = getLanguageVariant(languageCode);
    const requestUrl = articleUrl.includes('?') ? articleUrl : `${articleUrl}?variant=${languageVariant}`;
    const response = await axios.get(requestUrl, {
      params: { uselang: languageCode, setlang: languageCode },
      timeout: 10000,
      headers: { 'Accept-Language': `${languageCode},${languageCode}-*;q=0.9,en;q=0.8` }
    });
    if (response.status !== 200) {
      throw new Error(`HTTP错误: ${response.status}`);
    }
    const $ = cheerio.load(response.data);
    const title = $('#firstHeading').text().trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    const sections: { title?: string; content: string[] }[] = [];
    let currentSection: { title?: string; content: string[] } = { content: [] };
    $('#mw-content-text .mw-parser-output > *').each((_, element) => {
      const el = $(element);
      if (el.is('h2, h3, h4')) {
        if (currentSection.content.length && currentSection.content.join(' ').length >= 12) {
          sections.push(currentSection);
        }
        currentSection = {
          title: el.find('.mw-headline').text().trim().replace(/[\u200B-\u200D\uFEFF]/g, ''),
          content: []
        };
      }
      else if (el.is('p, ul, ol')) {
        const text = el.text().trim();
        if (text && !text.startsWith('[') && !text.startsWith('跳转') &&
            !el.hasClass('quote') && !el.hasClass('treeview')) {
          const cleanText = el.text().trim()
            .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ');
          if (cleanText.length > 0) {
            currentSection.content.push(cleanText);
          }
        }
      }
    });
    if (currentSection.content.length && currentSection.content.join(' ').length >= 12) {
      sections.push(currentSection);
    }
    if (!sections.length) {
      const cleanUrl = articleUrl.split('?')[0];
      return { title, content: `${title}：本页面没有内容。`, url: cleanUrl };
    }
    const formattedContent = sections
      .map((section, index) => {
        const sectionLimit = config.sectionLength < 0 ? Infinity : config.sectionLength;
        const sectionText = index === 0
          ? section.content.join(' ')
          : section.content.join(' ').slice(0, sectionLimit);
        const truncated = sectionText.length >= sectionLimit && index > 0 && config.sectionLength >= 0 ? '...' : '';
        return section.title ? `『${section.title}』${sectionText}${truncated}` : sectionText;
      }).join('\n');

    const totalLimit = config.totalLength < 0 ? Infinity : config.totalLength;
    const limitedContent = totalLimit === Infinity ? formattedContent : formattedContent.slice(0, totalLimit);
    const cleanUrl = articleUrl.split('?')[0];
    return {
      title,
      content: limitedContent.length >= totalLimit && config.totalLength >= 0 ? limitedContent + '...' : limitedContent,
      url: cleanUrl
    };
  } catch (error) {
    throw new Error(`获取Wiki内容失败: ${error.message}`);
  }
}

/**
 * 处理 Wiki 请求
 * @param {string} keyword - 搜索关键词
 * @param {string} userId - 用户ID
 * @param {MTConfig} config - 插件配置
 * @param {Map<string, LangCode>} userLangs - 用户语言设置
 * @param {'text' | 'image' | 'search'} mode - 请求模式
 * @returns {Promise<string | {results: any[], domain: string, lang: string} | {url: string, pageUrl: string}>}
 */
async function processWikiRequest(
  keyword: string,
  userId: string,
  config: MTConfig,
  userLangs: Map<string, LangCode>,
  mode: 'text' | 'image' | 'search' = 'text'
) {
  if (!keyword) return '请输入需要查询的关键词';
  keyword = keyword.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  try {
    const lang = userLangs.get(userId) || config.Language;
    const results = await searchWiki(keyword);
    if (!results || !results.length) {
      return `未找到与"${keyword}"相关的内容。`;
    }
    if (mode === 'search') {
      return {
        results,
        domain: lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`,
        lang
      };
    }
    const result = results[0];
    const pageUrl = buildUrl(result.title, lang, true);
    const displayUrl = buildUrl(result.title, lang);
    if (mode === 'image') {
      return { url: displayUrl, pageUrl };
    }
    try {
      const { title, content } = await fetchContent(pageUrl, lang, config);
      const contentSliced = content.slice(0, config.totalLength);
      const ellipsis = contentSliced.length >= config.totalLength ? '...' : '';
      return `『${title}』${contentSliced}${ellipsis}\n详细内容：${displayUrl}`;
    } catch (error) {
      return `获取"${result.title}"的内容时发生错误: ${error.message}`;
    }
  } catch (error) {
    return `查询"${keyword}"时发生错误: ${error.message}`;
  }
}

/**
 * 统一的搜索处理
 * @param {Object} params - 搜索参数
 * @param {string} params.keyword - 搜索关键词
 * @param {('wiki'|'mcmod')} params.source - 搜索源
 * @param {any} params.session - 会话对象
 * @param {MTConfig} params.config - Minecraft工具配置
 * @param {any} [params.ctx] - Koishi上下文对象
 * @param {LangCode} [params.lang] - 语言代码
 * @returns {Promise<string>} 搜索结果或错误信息
 */
export async function search(params: {
  keyword: string
  source: 'wiki' | 'mcmod'
  session: any
  config: MTConfig
  ctx?: any
  lang?: LangCode
}) {
  const { keyword, source, session, config, ctx, lang } = params
  if (!keyword) return '请输入搜索关键词'
  try {
    // 根据源选择相应的搜索函数
    const searchFn = source === 'wiki' ? searchWiki : (await import('./mod')).searchMod
    const results = await searchFn(keyword, config)
    if (!results.length) return '没有找到相关内容'
    const message = formatSearchResults(results, source, config)
    await session.send(message)
    const timeout = config.Timeout < 0 ? undefined : config.Timeout * 1000;
    const response = await session.prompt(timeout)
    if (!response) return '等待超时，已取消操作'
    return await processSelection({ response, results, source, config, ctx, lang, session })
  } catch (error) {
    return error.message
  }
}

/**
 * 格式化搜索结果
 * @param {SearchResult[]} results - 搜索结果列表
 * @param {('wiki'|'mcmod')} source - 搜索源
 * @param {MTConfig} config - Minecraft工具配置
 * @returns {string} 格式化后的搜索结果文本
 */
function formatSearchResults(
  results: SearchResult[],
  source: 'wiki' | 'mcmod',
  config: MTConfig
): string {
  const items = results.map((r, i) => {
    const base = `${i + 1}. ${r.title}`
    const showDesc = source === 'mcmod' && config.descLength !== 0 && r.desc;
    const desc = showDesc ? (config.descLength > 0
      ? `\n    ${r.desc.slice(0, config.descLength)}${r.desc.length > config.descLength ? '...' : ''}`
      : `\n    ${r.desc}`)
      : ''
    return `${base}${desc}`
  })
  return `${results[0].source === 'wiki' ? 'Wiki' : 'MCMOD'} 搜索结果：\n${items.join('\n')}输入序号查看详情（添加 -i 获取页面截图）`
}

/**
 * 处理用户选择
 * @param {Object} params - 处理参数
 * @param {string} params.response - 用户响应
 * @param {SearchResult[]} params.results - 搜索结果列表
 * @param {('wiki'|'mcmod')} params.source - 搜索源
 * @param {MTConfig} params.config - Minecraft工具配置
 * @param {any} [params.ctx] - Koishi上下文对象
 * @param {LangCode} [params.lang] - 语言代码
 * @param {any} [params.session] - 会话对象，用于获取平台信息
 * @returns {Promise<string>} 处理结果或错误信息
 */
async function processSelection(params: {
  response: string
  results: SearchResult[]
  source: 'wiki' | 'mcmod'
  config: MTConfig
  ctx?: any
  lang?: LangCode
  session?: any
}) {
  const { response, results, source, config, ctx, lang, session } = params
  const [input, flag] = response.split('-')
  const index = parseInt(input) - 1
  if (isNaN(index) || index < 0 || index >= results.length) {
    return '请输入正确的序号'
  }
  const result = results[index]
  const isImage = flag?.trim() === 'i'
  try {
    if (isImage) {
      return await capture(
        source === 'wiki' ? buildUrl(result.title, lang, true) : result.url,
        ctx,
        { type: source, lang },
        config
      ).then(res => res.image)
    } else {
      return await fetchWikiContent(result, source, config, lang, session)
    }
  } catch (error) {
    return `处理内容时出错 (${error?.message || String(error)})，请直接访问：${result.url}`
  }
}

/**
 * 获取页面内容
 * @param {SearchResult} result - 搜索结果项
 * @param {('wiki'|'mcmod')} source - 内容源
 * @param {MTConfig} config - Minecraft工具配置
 * @param {LangCode} [lang] - 语言代码
 * @param {any} [session] - 会话对象，用于获取平台信息
 * @returns {Promise<string>} 页面内容或错误信息
 */
async function fetchWikiContent(
  result: SearchResult,
  source: 'wiki' | 'mcmod',
  config: MTConfig,
  lang?: LangCode,
  session?: any
) {
  if (source === 'wiki') {
    const pageUrl = buildUrl(result.title, lang, true)
    const displayUrl = buildUrl(result.title, lang)
    const { title, content } = await fetchContent(pageUrl, lang, config)
    return `『${title}』${content}\n详细内容：${displayUrl}`
  }
  const { fetchModContent, formatContent } = await import('./mod')
  const content = await fetchModContent(result.url, config)
  return formatContent(content, result.url, {
    linkCount: config.linkCount,
    showImages: config.showImages,
    platform: session.platform
  }) || `内容获取失败，请访问：${result.url}`
}

/**
 * 注册 Minecraft Wiki 相关命令
 * @param {Context} ctx - Koishi 上下文
 * @param {Command} parent - 父命令
 * @param {MTConfig} config - 插件配置
 * @param {Map<string, LangCode>} userLangs - 用户语言设置
 */
export function registerWiki(ctx: Context, parent: any, config: MTConfig, userLangs: Map<string, LangCode>) {
  const mcwiki = parent.subcommand('.wiki <keyword:text>', '查询 Minecraft Wiki')
    .usage('mc.wiki <关键词> - 查询 Wiki\nmc.wiki.find <关键词> - 搜索 Wiki\nmc.wiki.shot <关键词> - 截图 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        return await processWikiRequest(keyword, session.userId, config, userLangs, 'text');
      } catch (error) {
        return error.message;
      }
    });
  mcwiki.subcommand('.find <keyword:text>', '搜索 Wiki')
    .usage('mc.wiki.find <关键词> - 搜索 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        const result = await processWikiRequest(keyword, session.userId, config, userLangs, 'search');
        if (typeof result === 'string') return result;
        return await search({
          keyword,
          source: 'wiki',
          session,
          config,
          ctx,
          lang: userLangs.get(session.userId) || config.Language
        });
      } catch (error) {
        return error.message;
      }
    });
  mcwiki.subcommand('.shot <keyword:text>', '截图 Wiki 页面')
    .usage('mc.wiki.shot <关键词> - 搜索并获取指定页面截图')
    .action(async ({ session }, keyword) => {
      try {
        const wikiResult = await processWikiRequest(keyword, session.userId, config, userLangs, 'image') as any;
        if (typeof wikiResult === 'string') return wikiResult;
        await session.send(`正在获取页面...\n完整内容：${wikiResult.url}`);
        const result = await capture(
          wikiResult.pageUrl,
          ctx,
          {
            type: 'wiki',
            lang: userLangs.get(session.userId) || config.Language
          },
          config
        );
        return result.image;
      } catch (error) {
        return error.message;
      }
    });
}