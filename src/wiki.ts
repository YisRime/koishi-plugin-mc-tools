import { Context } from 'koishi'
import * as cheerio from 'cheerio'
import axios from 'axios'
import { MinecraftToolsConfig, LangCode } from './index'
import { searchWiki, search, capture, sendForwardMessage } from './wikiservice'

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
        'Accept-Language': `${languageCode},${languageCode}-*;q=0.9,en;q=0.8`,
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
          : section.content.join(' ').slice(0, config.specific.sectionLength);
        if (section.title) {
          return `『${section.title}』${sectionText}${sectionText.length >= config.specific.sectionLength && index > 0 ? '...' : ''}`;
        }
        return sectionText;
      })
      .join('\n')
      .slice(0, config.common.totalLength);

    const cleanUrl = articleUrl.split('?')[0];
    return {
      title,
      content: formattedContent.length >= config.common.totalLength ? formattedContent + '...' : formattedContent,
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
 * @param {any} [session] - 会话对象，用于合并转发
 * @returns {Promise<string | {results: SearchResult[], domain: string, lang: string} | {url: string, pageUrl: string}>}
 */
export async function processWikiRequest(
  keyword: string,
  userId: string,
  config: MinecraftToolsConfig,
  userLangs: Map<string, LangCode>,
  mode: 'text' | 'image' | 'search' = 'text',
  session?: any
) {
  if (!keyword) return '请输入需要查询的关键词';

  keyword = keyword.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

  try {
    const lang = userLangs.get(userId) || config.specific.Language;
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
      // 先获取内容和标题
      const tempConfig = JSON.parse(JSON.stringify(config));
      tempConfig.common.totalLength = 10000;
      tempConfig.specific.sectionLength = 5000;

      const { title, content } = await fetchContent(pageUrl, lang, tempConfig);

      // 使用合并转发（如果启用且提供了session）
      if (config.common.useForwardMsg && session) {
        try {
          const response = await sendForwardMessage(session, `『${title}』`, content, displayUrl);

          // 如果返回的是字符串，说明平台不支持合并转发，直接返回内容
          if (typeof response === 'string') {
            return response;
          }
          return '';
        } catch (error) {
          return `获取"${title}"的内容时发生错误: ${error.message}`;
        }
      }

      // 如果不使用合并转发，或者标题是纯数字和点组合，则使用默认方式返回
      const contentSliced = content.slice(0, config.common.totalLength);
      return `『${title}』${contentSliced}${contentSliced.length >= config.common.totalLength ? '...' : ''}\n详细内容：${displayUrl}`;

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
 * @param {Command} parent - 父命令
 * @param {MinecraftToolsConfig} config - 插件配置
 * @param {Map<string, LangCode>} userLangs - 用户语言设置
 */
export function registerWikiCommands(ctx: Context, parent: any, config: MinecraftToolsConfig, userLangs: Map<string, LangCode>) {
  const mcwiki = parent.subcommand('.wiki <keyword:text>', '查询 Minecraft Wiki')
    .usage('mc.wiki <关键词> - 查询 Wiki\nmc.wiki.find <关键词> - 搜索 Wiki\nmc.wiki.shot <关键词> - 截图 Wiki 页面')
    .action(async ({ session }, keyword) => {
      try {
        // 传递session参数以支持合并转发
        const result = await processWikiRequest(keyword, session.userId, config, userLangs, 'text', session)
        return result
      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.find <keyword:text>', '搜索 Wiki')
    .usage('mc.wiki.find <关键词> - 搜索 Wiki 页面')
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
          lang: userLangs.get(session.userId) || config.specific.Language
        })
      } catch (error) {
        return error.message
      }
    })

  mcwiki.subcommand('.shot <keyword:text>', '截图 Wiki 页面')
    .usage('mc.wiki.shot <关键词> - 搜索并获取指定页面截图')
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
            lang: userLangs.get(session.userId) || config.specific.Language
          },
          config
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })
}
