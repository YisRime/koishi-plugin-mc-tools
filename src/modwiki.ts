/**
 * @module modwiki
 * @description MCMOD.CN 内容抓取和解析模块
 */

import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { CommonConfig } from './index'

/**
 * 处理结果接口
 * @interface ProcessResult
 */
interface ProcessResult {
  /** 处理后的内容段落 */
  sections: string[];
  /** 相关链接列表 */
  links: string[];
}

/**
 * 解析图片元素
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @param {cheerio.Cheerio} $elem 包含图片的元素
 * @returns {string|null} 图片HTML字符串或null
 */
function parseImage($: cheerio.CheerioAPI, $elem: cheerio.Cheerio<any>): string | null {
  const $img = $elem.find('img')
  const src = $img.attr('data-src') || $img.attr('src')
  return src ? h.image(src.startsWith('//') ? `https:${src}` : src).toString() : null
}

/**
 * 解析链接元素
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @param {cheerio.Cheerio} $elem 包含链接的元素
 * @returns {string|null} 处理后的链接文本或null
 */
function parseLink($: cheerio.CheerioAPI, $elem: cheerio.Cheerio<any>): string | null {
  const links: string[] = []

  $elem.find('[id^="link_"]').each((_, elem) => {
    const $link = $(elem)
    const id = $link.attr('id')
    if (!id) return

    const scriptContent = $(`script:contains(${id})`).text()
    const urlMatch = scriptContent.match(/content:"[^"]*?<strong>([^<]+)/)
    if (urlMatch && urlMatch[1]) {
      const url = urlMatch[1]
      // 获取链接文本描述
      let prefix = ''
      let prevNode = $link[0].previousSibling
      while (prevNode && prevNode.type === 'text') {
        prefix = prevNode.data.trim() + ' ' + prefix
        prevNode = prevNode.previousSibling
      }
      prefix = prefix.trim()
      // 判断链接文本是否为URL格式
      const linkText = $link.text().trim()
      const isUrl = linkText.match(/^https?:\/\//)
      // 使用 Markdown 格式处理链接:
      const formattedLink = isUrl ? url : `[${linkText}](${url})`
      links.push(prefix ? `${prefix} ${formattedLink}` : formattedLink)
    }
  })

  return links.length > 0 ? links.join('\n') : null
}

/**
 * 解析文本元素
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @param {cheerio.Cheerio} $elem 包含文本的元素
 * @returns {string|null} 处理后的文本或null
 */
function parseText($: cheerio.CheerioAPI, $elem: cheerio.Cheerio<any>): string | null {
  const cleanText = (text: string): string => {
    const clearedText = text
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]|\[(\w+)\]|本帖最后由.+编辑|复制代码/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    // 判断是否为标题
    const isTitle = (text: string): boolean => {
      if (text.length > 12) return false
      const $parent = $elem.parent()
      if ($parent.find('strong').length ||
          $parent.find('span.common-text-title').length) {
        return true
      }
      return false
    }
    return !clearedText ? '' : isTitle(clearedText) ? `『${clearedText}』` : clearedText
  }

  const cleanedElem = $elem.clone()
  cleanedElem.find('script, i.pstatus, .fastcopy').remove()

  // 处理链接
  cleanedElem.find('a').each((_, link) => {
    const $link = $(link)
    const href = $link.attr('href')
    const text = $link.text().trim()

    if (href && text) {
      let processedHref = href
      if (href.startsWith('//')) {
        processedHref = `https:${href}`
      } else if (href.startsWith('/')) {
        processedHref = `https://www.mcmod.cn${href}`
      }

      // 忽略 javascript 和锚点链接
      if (!href.includes('javascript:') && !href.startsWith('#')) {
        let prefix = ''
        let prevNode = link.previousSibling
        while (prevNode && prevNode.type === 'text') {
          prefix = prevNode.data.trim() + ' ' + prefix
          prevNode.data = ''
          prevNode = prevNode.previousSibling
        }
        prefix = prefix.trim()
        const isUrl = text.match(/^https?:\/\//)
        const markdownLink = isUrl ? processedHref : `[${text}](${processedHref})`
        const linkText = prefix ? `${prefix} ${markdownLink}` : markdownLink
        $link.replaceWith(linkText)
      }
    }
  })

  const text = cleanText(cleanedElem.text())
  return text && !text.includes('此链接会跳转到') && !text.includes('不要再提示我') ? text : null
}

/**
 * 解析页面内容
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @param {'mod'|'modpack'|'post'|'item'|'bbs'} pageType 页面类型
 * @param {number} maxLength 最大内容长度
 * @returns {ProcessResult} 处理结果
 */
function parseContent($: cheerio.CheerioAPI, pageType: 'mod' | 'modpack' | 'post' | 'item' | 'bbs', maxLength: number): ProcessResult {
  const sections: string[] = []
  const relatedLinks: string[] = []
  let totalLength = 0

  // 解析头部信息
  if (pageType === 'item') {
    parseItemHeader($, sections)
  } else if (['mod', 'modpack'].includes(pageType)) {
    sections.push(...parseBasicInfo($))
  } else if (pageType === 'bbs') {
    const title = $('#thread_subject').first().text().trim()
    if (title) sections.push(title)
  }

  // 解析主要内容区域
  const contentSelector = {
    mod: '.common-text',
    modpack: '.common-text',
    post: 'div.text',
    item: '.item-content.common-text',
    bbs: '[id^="postmessage_"]'
  }[pageType]

  const $content = $(contentSelector).first()
  // 顺序处理每个元素
  $content.children().each((_, element) => {
    const $elem = $(element)
    // 解析图片
    const image = parseImage($, $elem)
    if (image) {
      sections.push(image)
      return
    }
    // 解析链接
    const link = parseLink($, $elem)
    if (link) {
      sections.push(link)
      return
    }
    // 解析文本
    const text = parseText($, $elem)
    if (text && totalLength < maxLength) {
      sections.push(text)
      if (!text.startsWith('http')) {
        totalLength += text.length
      }
    }
  })

  relatedLinks.push(...parseRelatedLinks($))

  return {
    sections: sections.filter((s, i, arr) => s.trim() && arr.indexOf(s) === i),
    links: relatedLinks
  }
}

/**
 * 解析物品头部信息
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @param {string[]} sections 段落数组
 */
function parseItemHeader($: cheerio.CheerioAPI, sections: string[]): void {
  const itemName = $('.itemname .name h5').first().text().trim()
  const title = itemName || $('.class-title h3').first().text().trim() +
    ($('.class-title h4').first().text().trim() ? ` (${$('.class-title h4').first().text().trim()})` : '')
  sections.push(title)

  const $itemIcon = $('.item-info-table')
  if ($itemIcon.length) {
    const image = parseImage($, $itemIcon)
    if (image) sections.push(image)
  }
}

/**
 * 解析基础信息
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @returns {string[]} 基础信息数组
 */
function parseBasicInfo($: cheerio.CheerioAPI): string[] {
  return [
    ...parseHeader($),
    ...parseInfoBlock($),
    ...parseVersions($)
  ]
}

/**
 * 解析标题和封面
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @returns {string[]} 标题和封面信息数组
 */
function parseHeader($: cheerio.CheerioAPI): string[] {
  const sections: string[] = [];
  const shortName = $('.short-name').first().text().trim();
  const title = $('.class-title h3').first().text().trim();
  const enTitle = $('.class-title h4').first().text().trim();
  const modStatusLabels = $(`.class-official-group .class-status`).map((_, el) => $(el).text().trim()).get()
    .concat($(`.class-official-group .class-source`).map((_, el) => $(el).text().trim()).get());

  sections.push(`${shortName} ${enTitle} | ${title}${
    modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''
  }`);
  // 处理封面图片
  const $coverImage = $('.class-cover-image');
  if ($coverImage.length) {
    const imageResult = parseImage($, $coverImage);
    if (imageResult) {
      sections.push(imageResult);
    }
  }

  return sections;
}

/**
 * 解析信息块
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @returns {string[]} 信息块内容数组
 */
function parseInfoBlock($: cheerio.CheerioAPI): string[] {
  const sections: string[] = [];

  $('.class-info-left .col-lg-4').each((_, elem) => {
    const text = $(elem).text().trim().replace(/\s+/g, ' ').replace(/：/g, ':');
    if (text.includes('支持的MC版本')) return;

    const infoTypes = ['整合包类型', '运作方式', '打包方式', '运行环境'];
    if (infoTypes.some(t => text.includes(t))) {
      sections.push(text);
    }
  });

  return sections;
}

/**
 * 处理游戏版本列表，合并相似版本
 */
function processVersionNumbers(versions: string[]): string[] {
  if (!versions?.length) return [];

  const grouped = versions.reduce((groups, version) => {
    const mainVersion = version.match(/^(\d+\.\d+)/)?.[1] || version;
    groups.set(mainVersion, (groups.get(mainVersion) || []).concat(version));
    return groups;
  }, new Map<string, string[]>());

  return Array.from(grouped.entries())
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .map(([main, group]) =>
      group.length > 1 ? `${main}(${group.length}个版本)` : group[0]
    );
}

/**
 * 解析版本信息
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @returns {string[]} 版本信息数组
 */
function parseVersions($: cheerio.CheerioAPI): string[] {
  const sections: string[] = ['支持版本:'];
  const processedLoaders = new Set<string>();

  $('.mcver ul').each((_, ul) => {
    const $ul = $(ul);
    const loader = $ul.find('li:first').text().trim();
    if (loader && !processedLoaders.has(loader)) {
      const versions = $ul.find('a')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(v => v.match(/^\d/));

      if (versions.length) {
        const processedVersions = processVersionNumbers(versions);
        sections.push(`${loader} ${processedVersions.join(', ')}`);
        processedLoaders.add(loader);
      }
    }
  });

  return sections.length > 1 ? sections : [];
}

/**
 * 解析相关链接
 * @param {cheerio.CheerioAPI} $ Cheerio实例
 * @returns {string[]} 相关链接数组
 */
function parseRelatedLinks($: cheerio.CheerioAPI): string[] {
  const linkMap = new Map<string, { url: string; name: string }>()

  $('.common-link-frame .list ul li').each((_, item) => {
    try {
      const $item = $(item)
      const $link = $item.find('a')
      const url = $link.attr('href')
      const rawType = $link.attr('data-original-title') || $item.find('.name').text().trim()

      if (!url || !rawType) return

      const [type, customName] = rawType.split(':').map(s => s.trim())
      const name = customName || type
      let processedUrl = url

      if (url.startsWith('//link.mcmod.cn/target/')) {
        try {
          const encodedPart = url.split('target/')[1]
          processedUrl = Buffer.from(encodedPart, 'base64').toString('utf-8')
        } catch {
          processedUrl = url
        }
      } else if (url.startsWith('//')) {
        processedUrl = `https:${url}`
      }

      if (!linkMap.has(type)) {
        linkMap.set(type, { url: processedUrl, name })
      }
    } catch (error) {
      console.warn('处理链接时出错:', error)
    }
  })

  return Array.from(linkMap.entries())
    .map(([type, { url, name }]) => `${type}${name !== type ? ` (${name})` : ''}: ${url}`)
}

/**
 * 格式化内容
 * @param {ProcessResult} result 处理结果
 * @param {string} url 原始页面URL
 * @param {object} options 显示选项
 * @returns {string} 格式化后的内容
 */
export function formatContent(result: ProcessResult, url: string, options: {
  linkCount?: number,
  showImages?: 'always' | 'noqq' | 'never',
  platform?: string
} = {}): string {
  if (!result?.sections) {
    return `无法获取页面内容，请访问：${url}`;
  }

  const sections = result.sections.filter(Boolean).map(section =>
    section.toString().trim()
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
  );

  const categorizedSections = {
    title: sections[0],
    coverImage: sections[1],
    basicInfo: sections.filter(s =>
      ['运行环境', '整合包类型', '运作方式', '打包方式']
        .some(type => s.includes(type))
    ),
    versionInfo: sections.filter(s =>
      s === '支持版本:' || ['行为包:', 'Forge:', 'Fabric:']
        .some(type => s.includes(type))
    ),
    content: sections.filter((s, index) =>
      index > 1 &&
      !['运行环境', '整合包类型', '运作方式', '打包方式']
        .some(type => s.includes(type)) &&
      !['支持版本:', '行为包:', 'Forge:', 'Fabric:']
        .some(type => s.includes(type))
    ).map((s, i, arr) => {
      if (i === arr.length - 1 && !s.startsWith('http') && !s.endsWith('...')) {
        return s + '...';
      }
      return s;
    }),
    images: sections.filter((s, index) =>
      index > 1 && s.startsWith('http') && !s.includes(':')
    )
  };

  const links = result.links?.length
    ? ['相关链接:', ...result.links.slice(0, options.linkCount)]
    : [];

  // 判断是否显示图片
  const shouldShowImages =
    options.showImages === 'always' ||
    (options.showImages === 'noqq' && options.platform !== 'qq');

  const output = [
    categorizedSections.title,
    categorizedSections.coverImage,
    ...categorizedSections.basicInfo,
    ...categorizedSections.versionInfo,
    ...(links.length ? links : []),
    '简介:',
    ...categorizedSections.content,
    ...(shouldShowImages ? categorizedSections.images : []),
    `详细内容: ${url}`
  ];

  return output
    .filter(s => s && s.length > 0)
    .join('\n')
    .trim() || `无法获取详细内容，请访问：${url}`;
}

/**
 * 获取MCMOD内容
 * @param {string} url MCMOD.CN页面URL
 * @param {ModwikiConfig} config 配置项
 * @returns {Promise<ProcessResult>} 处理结果Promise
 * @throws {Error} 当请求失败或页面不存在时抛出错误
 */
export async function fetchModContent(url: string, config: CommonConfig): Promise<ProcessResult> {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    if ($('.class-404').length > 0) {
      throw new Error('该页面不存在或已被删除');
    }

    const pageType = url.includes('/modpack/') ? 'modpack'
                   : url.includes('/post/') ? 'post'
                   : url.includes('/item/') ? 'item'
                   : url.includes('bbs.mcmod.cn') ? 'bbs'
                   : 'mod';
    const content = parseContent($, pageType, config.totalLength);
    const sections = content.sections;

    return {
      sections,
      links: content.links
    };

  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.code === 'ECONNABORTED'
        ? '请求超时，请稍后再试'
        : `内容获取失败：${error.message}`);
    }
    throw error;
  }
}
