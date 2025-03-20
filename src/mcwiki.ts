import { Context } from 'koishi'
import * as cheerio from 'cheerio'
import axios from 'axios'
import { MinecraftToolsConfig, LangCode } from './index'
import { searchWiki, search, capture } from './subwiki'

/**
 * 构建 Wiki URL
 * @param {string} articleTitle - 文章标题
 * @param {LangCode | string} languageCode - 语言代码
 * @param {boolean} includeLanguageVariant - 是否包含语言变体参数
 * @returns {string} 构建好的 Wiki URL
 */
export function buildUrl(articleTitle: string, languageCode: LangCode | string, includeLanguageVariant = false) {

  const cleanTitle = articleTitle.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

  let wikiDomain: string
  let languageVariant: string = ''

  if (typeof languageCode === 'string') {
    if (languageCode.startsWith('zh')) {
      wikiDomain = 'zh.minecraft.wiki'
      languageVariant = languageCode === 'zh' ? 'zh-cn' :
                languageCode === 'zh-hk' ? 'zh-hk' :
                languageCode === 'zh-tw' ? 'zh-tw' : 'zh-cn'
    } else {
      wikiDomain = languageCode === 'en' ? 'minecraft.wiki' : `${languageCode}.minecraft.wiki`
    }
  }

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
 * 格式化文章标题
 * @param {any} data - 文章数据
 * @returns {string} 格式化后的标题
 */
export function formatTitle(data: any): string {
  if (!data) return '条目不存在'

  const parts = []

  if (data.title) parts.push(`${data.title}`)

  return parts.join(' ')
}

/**
 * 获取 Wiki 文章内容
 * @param {string} articleUrl - 文章URL
 * @param {LangCode} languageCode - 语言代码
 * @param {MinecraftToolsConfig} config - 插件配置
 * @returns {Promise<{title: string, content: string, url: string}>}
 */
export async function fetchContent(articleUrl: string, languageCode: LangCode, config: MinecraftToolsConfig) {
  try {
    const languageVariant = languageCode.startsWith('zh') ?
      (languageCode === 'zh' ? 'zh-cn' :
      languageCode === 'zh-hk' ? 'zh-hk' :
      languageCode === 'zh-tw' ? 'zh-tw' : 'zh-cn') : '';
    const requestUrl = articleUrl.includes('?') ? articleUrl : `${articleUrl}?variant=${languageVariant}`;
    const response = await axios.get(requestUrl, {
      params: {
        uselang: languageCode,
        setlang: languageCode
      },
      timeout: 10000,
      headers: {
        'User-Agent': 'KoishiBot/1.0 (https://github.com/koishijs/koishi)'
      }
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
        if (currentSection.content.length) {
          const totalLength = currentSection.content.join(' ').length;
          if (totalLength >= 12) {
            sections.push(currentSection);
          }
        }
        currentSection = {
          title: el.find('.mw-headline').text().trim().replace(/[\u200B-\u200D\uFEFF]/g, ''),
          content: []
        };
      }
      else if (el.is('p, ul, ol')) {
        const text = el.text().trim();
        if (text && !text.startsWith('[') &&
            !text.startsWith('跳转') &&
            !el.hasClass('quote') &&
            !el.hasClass('treeview')) {

          const cleanText = el.text()
            .trim()
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ');

          if (cleanText.length > 0) {
            currentSection.content.push(cleanText);
          }
        }
      }
    });

    if (currentSection.content.length) {
      const totalLength = currentSection.content.join(' ').length;
      if (totalLength >= 12) {
        sections.push(currentSection);
      }
    }

    if (!sections.length) {
      const cleanUrl = articleUrl.split('?')[0];
      return { title, content: `${title}：本页面没有内容。`, url: cleanUrl };
    }

    const formattedContent = sections
      .map((section, index) => {
        const sectionText = index === 0
          ? section.content.join(' ')
          : section.content.join(' ').slice(0, config.search.sectionLength);
        if (section.title) {
          return `『${section.title}』${sectionText}${sectionText.length >= config.search.sectionLength && index > 0 ? '...' : ''}`;
        }
        return sectionText;
      })
      .join('\n')
      .slice(0, config.wiki.totalLength);

    const cleanUrl = articleUrl.split('?')[0];
    return {
      title,
      content: formattedContent.length >= config.wiki.totalLength ? formattedContent + '...' : formattedContent,
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
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {Map<string, LangCode>} userLangs - 用户语言设置
 * @param {'text' | 'image' | 'search'} mode - 请求模式
 * @returns {Promise<string | {results: SearchResult[], domain: string, lang: string} | {url: string, pageUrl: string}>}
 */
export async function processWikiRequest(keyword: string, userId: string, config: MinecraftToolsConfig, userLangs: Map<string, LangCode>, mode: 'text' | 'image' | 'search' = 'text') {
  if (!keyword) return '请输入需要查询的关键词';

  keyword = keyword.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

  try {
    const lang = userLangs.get(userId) || config.search.Language;
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
      return {
        url: displayUrl,
        pageUrl
      };
    }

    try {
      const { content, url } = await fetchContent(pageUrl, lang, config);
      return `${content}\n详细内容：${url}`;
    } catch (error) {
      return `获取"${result.title}"的内容时发生错误: ${error.message}`;
    }
  } catch (error) {
    return `查询"${keyword}"时发生错误: ${error.message}`;
  }
}

/**
 * 注册 Minecraft Wiki 相关命令
 * @param {Context} ctx - Koishi 上下文
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {Map<string, LangCode>} userLangs - 用户语言设置
 */
export function registerWikiCommands(ctx: Context, config: MinecraftToolsConfig, userLangs: Map<string, LangCode>) {
  const mcwiki = ctx.command('mcwiki <keyword:text>', '查询 Minecraft Wiki')
    .usage('mcwiki <关键词> - 查询 Wiki\nmcwiki.find <关键词> - 搜索 Wiki\nmcwiki.shot <关键词> - 截图 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        const result = await processWikiRequest(keyword, session.userId, config, userLangs)
        return result
      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.find <keyword:text>', '搜索 Wiki')
    .usage('mcwiki.find <关键词> - 搜索 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        const result = await processWikiRequest(keyword, session.userId, config, userLangs, 'search') as any
        if (typeof result === 'string') return result

        return await search({
          keyword,
          source: 'wiki',
          session,
          config,
          ctx,
          lang: userLangs.get(session.userId) || config.search.Language
        })
      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.shot <keyword:text>', '截图 Wiki 页面')
    .usage('mcwiki.shot <关键词> - 搜索并获取指定页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'

      try {
        const wikiResult = await processWikiRequest(keyword, session.userId, config, userLangs, 'image') as any
        if (typeof wikiResult === 'string') return wikiResult

        await session.send(`正在获取页面...\n完整内容：${wikiResult.url}`)
        const result = await capture(
          wikiResult.pageUrl,
          ctx,
          {
            type: 'wiki',
            lang: userLangs.get(session.userId) || config.search.Language
          },
          config
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })
}
