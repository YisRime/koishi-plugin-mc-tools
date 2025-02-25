import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { ModwikiConfig } from './utils'

/**
 * 处理结果接口
 */
interface ProcessResult {
  /** 处理后的内容段落 */
  sections: string[];
  /** 相关链接列表 */
  links: string[];
}

/**
 * 清理文本内容
 * @param {string} text - 待清理的文本
 * @returns {string} 清理后的文本
 */
function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\[(\w+)\]/g, '')
    .trim();
}

/**
 * 处理图片元素
 * @param {cheerio.CheerioAPI} $ - Cheerio 实例
 * @param {cheerio.Cheerio<any>} $img - 图片元素
 * @param {string[]} sections - 现有段落列表
 * @returns {string[]} 更新后的段落列表
 */
function processImage($: cheerio.CheerioAPI, $img: cheerio.Cheerio<any>, sections: string[]): string[] {
  let imgSrc = $img.attr('data-src') || $img.attr('src');
  if (imgSrc?.startsWith('//')) {
    imgSrc = `https:${imgSrc}`;
  }
  return imgSrc ? [...sections, h.image(imgSrc).toString()] : sections;
}

/**
 * 判断文本是否为段落标题
 * @param {string} text - 待判断文本
 * @returns {boolean} 是否为段落标题
 */
function isSectionTitle(text: string): boolean {
  return /^(简介|注意事项|相关消息|相关链接)$/.test(text.trim()) ||
         /^[\u4e00-\u9fa5\w\s]+$/.test(text.trim());
}

function formatSection(text: string): string {
  if (text.length < 20 && !text.includes('：') && !text.includes(':')) {
    return isSectionTitle(text) ? `『${text.trim()}』` : text;
  }
  return text;
}

/**
 * 处理HTML元素内容
 * @param {cheerio.Cheerio<any>} $elem - 要处理的元素
 * @returns {string | null} 处理后的文本或null
 */
function processElement($: cheerio.CheerioAPI, $elem: cheerio.Cheerio<any>): string | null {
  // 跳过脚本和弹出相关内容
  if ($elem.find('script').length ||
      $elem.is('script') ||
      $elem.text().includes('前往链接') ||
      $elem.text().includes('不要再提示我')) {
    return null;
  }

  // 处理图片
  if ($elem.find('.figure').length || $elem.is('.figure')) {
    const $img = $elem.find('img');
    const imgSrc = $img.attr('data-src') || $img.attr('src');
    return imgSrc ? h.image(imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc).toString() : null;
  }

  // 处理文本之前先处理链接
  const cleanedElem = $elem.clone();
  cleanedElem.find('script').remove();

  // 处理站外弹出链接
  cleanedElem.find('[id^="link_"]').each((_, elem) => {
    const $link = $(elem);
    const id = $link.attr('id');
    if (!id) return;

    // 查找包含这个链接ID的script标签
    const scriptContent = $(`script:contains(${id})`).text();
    // 提取URL - 修改正则表达式以更准确地匹配URL格式
    const urlMatch = scriptContent.match(/content:"[^"]*?<strong>([^<]+)/);
    if (urlMatch && urlMatch[1]) {
      const url = urlMatch[1];
      $link.text(`${$link.text()} (${url})`);
      $link.removeAttr('onclick');
      $link.attr('href', url);
    }
  });

  // 处理普通链接
  cleanedElem.find('a').each((_, link) => {
    const $link = $(link);
    const href = $link.attr('href');
    const text = $link.text().trim();

    if (href && text) {
      // 如果是站内链接，保持原样
      if (href.startsWith('//www.mcmod.cn') || href.startsWith('/')) {
        return;
      }
      // 如果已经处理过的站外弹出链接，跳过
      if ($link.attr('id')?.startsWith('link_')) {
        return;
      }
      // 将链接文本替换为 "文本 (链接)"
      if (!href.includes('javascript:') && !href.startsWith('#')) {
        $link.text(`${text} (${href})`);
      }
    }
  });

  const text = cleanText(cleanedElem.text());

  return text &&
         !text.includes('前往链接') &&
         !text.includes('不要再提示我') ? text : null;
}

/**
 * 处理页面主要内容
 * @param {cheerio.CheerioAPI} $ - Cheerio 实例
 * @param {'mod' | 'modpack' | 'post' | 'item'} pageType - 页面类型
 * @param {number} maxLength - 最大内容长度
 * @returns {{sections: string[], links: string[]}} 处理结果
 */
function processPageContent($: cheerio.CheerioAPI, pageType: 'mod' | 'modpack' | 'post' | 'item', maxLength: number): {
  sections: string[];
  links: string[];
} {
  const sections: string[] = [];
  let totalLength = 0;

  if (pageType === 'item') {
    const itemName = $('.itemname .name h5').first().text().trim();
    const title = itemName || $('.class-title h3').first().text().trim() +
      ($('.class-title h4').first().text().trim() ? ` (${$('.class-title h4').first().text().trim()})` : '');
    sections.push(title);

    const $itemIcon = $('.item-info-table img').first();
    if ($itemIcon.length) {
      const imgSrc = $itemIcon.attr('data-src') || $itemIcon.attr('src');
      if (imgSrc) {
        sections.push(h.image(imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc).toString());
      }
    }
  } else if (pageType === 'mod' || pageType === 'modpack') {
    sections.push(...processBasicInfo($));
    sections.push(...processVersionInfo($));
  }

  const contentSelector = {
    mod: '.common-text',
    modpack: '.common-text',
    post: 'div.text',
    item: '.item-content.common-text'
  }[pageType];

  $(contentSelector).children().each((_, element) => {
    if (totalLength >= maxLength) return false;

    const result = processElement($, $(element));
    if (result) {
      sections.push(result);
      if (!result.startsWith('http')) {
        totalLength += result.length;
      }
    }
  });

  return {
    sections: sections
      // 清理空白行和重复内容
      .filter((section, index, array) =>
        section.trim() && array.indexOf(section) === index
      ),
    links: processRelatedLinks($)
  };
}

function processBasicInfo($: cheerio.CheerioAPI): string[] {
  const sections: string[] = [];
  const shortName = $('.short-name').first().text().trim();
  const title = $('.class-title h3').first().text().trim();
  const enTitle = $('.class-title h4').first().text().trim();

  const modStatusLabels = $(`.class-official-group .class-status`).map((_, el) => $(el).text().trim()).get()
    .concat($(`.class-official-group .class-source`).map((_, el) => $(el).text().trim()).get());

  sections.push(`${shortName} ${enTitle} | ${title}${
    modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''
  }`);

  const $coverImage = $('.class-cover-image img').first();
  if ($coverImage.length) {
    sections.push(...processImage($, $coverImage, []));
  }

  $('.class-info-left .col-lg-4').each((_, elem) => {
    const text = cleanText($(elem).text()).replace(/：/g, ':');
    if (text.includes('支持的MC版本')) return;

    const infoTypes = ['整合包类型', '运作方式', '打包方式', '运行环境'];
    if (infoTypes.some(t => text.includes(t))) {
      sections.push(text);
    }
  });

  return sections;
}

function processVersionInfo($: cheerio.CheerioAPI): string[] {
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
        sections.push(`${loader} ${versions.join(', ')}`);
        processedLoaders.add(loader);
      }
    }
  });

  return sections.length > 1 ? sections : [];
}

// 处理相关链接
function processRelatedLinks($: cheerio.CheerioAPI): string[] {
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
 * 格式化内容段落
 * @param {ProcessResult} result - 处理结果
 * @param {string} url - 原始URL
 * @returns {string} 格式化后的内容
 */
export function formatContentSections(result: ProcessResult, url: string): string {
  if (!result?.sections) {
    return `获取内容失败，请访问：${url}`;
  }

  const sections = result.sections.filter(Boolean).map(section =>
    section.toString().trim()
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
  );

  const categorizedSections = {
    title: sections[0],
    images: sections.filter(s => s.startsWith('http')),
    basicInfo: sections.filter(s =>
      ['运行环境', '整合包类型', '运作方式', '打包方式']
        .some(type => s.includes(type))
    ),
    versionInfo: sections.filter(s =>
      s === '支持版本:' || ['行为包:', 'Forge:', 'Fabric:']
        .some(type => s.includes(type))
    ),
    content: sections.filter(s =>
      !s.startsWith('http') &&
      !['运行环境', '整合包类型', '运作方式', '打包方式']
        .some(type => s.includes(type)) &&
      !['支持版本:', '行为包:', 'Forge:', 'Fabric:']
        .some(type => s.includes(type)) &&
      s !== sections[0]
    ).map(formatSection)
  };

  const output = [
    categorizedSections.title,
    '',
    categorizedSections.images[0],
    '',
    ...categorizedSections.basicInfo,
    '',
    ...categorizedSections.versionInfo,
    '',
    ...(result.links?.length ? [
      '相关链接:',
      ...result.links,
      ''
    ] : []),
    '简介:',
    ...categorizedSections.content,
    '',
    ...categorizedSections.images.slice(1),
    '',
    `详细内容: ${url}`
  ];

  return output
    .filter(Boolean)
    .join('\n')
    .trim() || `无法获取详细内容，请访问：${url}`;
}

/**
 * 处理 MCMOD 内容
 * @param {string} url - 页面URL
 * @param {ModwikiConfig} config - 插件配置
 * @returns {Promise<ProcessResult>} 处理结果
 */
export async function processMCMODContent(url: string, config: ModwikiConfig): Promise<ProcessResult> {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    if ($('.class-404').length > 0) {
      throw new Error('页面不存在');
    }

    const pageType = url.includes('/modpack/') ? 'modpack'
                   : url.includes('/post/') ? 'post'
                   : url.includes('/item/') ? 'item'
                   : 'mod';
    const content = processPageContent($, pageType, config.totalPreviewLength);
    const sections = content.sections;

    return {
      sections,
      links: content.links
    };

  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.code === 'ECONNABORTED'
        ? '请求超时，请稍后重试'
        : `获取内容失败: ${error.message}`);
    }
    throw error;
  }
}
