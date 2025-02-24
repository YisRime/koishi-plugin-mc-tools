import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { ModwikiConfig } from './utils'

interface ProcessResult {
  sections: string[];
  links: string[];
}

// 工具函数
function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\[(\w+)\]/g, '')
    .trim();
}

function processImage($: cheerio.CheerioAPI, $img: cheerio.Cheerio<any>, sections: string[]): string[] {
  let imgSrc = $img.attr('data-src') || $img.attr('src');
  if (imgSrc?.startsWith('//')) {
    imgSrc = `https:${imgSrc}`;
  }
  return imgSrc ? [...sections, h.image(imgSrc).toString()] : sections;
}

// 主要处理函数
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

  // 获取所有带有标题的版本信息
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

// 辅助函数 - 处理相关链接
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

// 修改内容格式化函数
function formatTitle(text: string): string {
  // 常见的标题模式
  const titlePatterns = [
    /^(简介|注意事项|相关消息|既往版本一览|相关链接)$/,
    /^[\u4e00-\u9fa5\w\s]+$/
  ];

  // 检查是否匹配任一标题模式
  if (titlePatterns.some(pattern => pattern.test(text.trim()))) {
    return `『${text.trim()}』`;
  }
  return text;
}

export function formatContentSections(result: ProcessResult, url: string): string {
  if (!result?.sections) {
    console.warn('无效的结果对象');
    return `获取内容失败，请直接访问：${url}`;
  }

  const sections = result.sections.filter(Boolean).map(section =>
    section.toString().trim().replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
  ).filter(Boolean);

  // 组织最终输出
  const output = [
    // 标题
    sections[0],
    '',
    // 图片 - 只显示第一个图片链接
    sections.find(s => s.startsWith('http')),
    '',
    // 基本信息
    ...sections.filter(s =>
      s.includes('运行环境') ||
      s.includes('整合包类型') ||
      s.includes('运作方式') ||
      s.includes('打包方式')
    ),
    '',
    // 版本信息
    ...sections.filter(s =>
      s === '支持版本:' ||
      s.includes('行为包:') ||
      s.includes('Forge:') ||
      s.includes('Fabric:')
    ),
    '',
    // 相关链接
    ...(result.links?.length ? [
      '相关链接:',
      ...result.links,
      ''
    ] : []),
    // 简介部分
    '简介:',
    ...sections.filter(s =>
      !s.startsWith('http') &&
      !s.includes('运行环境') &&
      !s.includes('整合包类型') &&
      !s.includes('运作方式') &&
      !s.includes('打包方式') &&
      !s.includes('支持版本:') &&
      !s.includes('行为包:') &&
      !s.includes('Forge:') &&
      !s.includes('Fabric:') &&
      s !== sections[0]
    ).map(section => {
      // 对可能的段落标题进行格式化
      const lines = section.split('\n').map(line => {
        if (line.trim().length < 20 && !line.includes('：') && !line.includes(':')) {
          return formatTitle(line);
        }
        return line;
      });
      return lines.join('\n');
    }),
    '',
    // 其他图片
    ...sections.filter((s, i) =>
      s.startsWith('http') &&
      sections.indexOf(s) !== sections.findIndex(x => x.startsWith('http'))
    ),
    '',
    `详细内容: ${url}`
  ];

  // 过滤空行并格式化
  return output
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || `无法获取详细内容，请直接访问：${url}`;
}

// 统一的内容处理函数
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

    const $elem = $(element);
    if ($elem.find('.figure').length || $elem.is('.figure')) {
      const $img = $elem.find('img');
      const imgSrc = $img.attr('data-src') || $img.attr('src');
      if (imgSrc) {
        sections.push(h.image(imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc).toString());
      }
    } else {
      const text = cleanText($elem.clone().find('script').remove().end().text());
      if (text) {
        sections.push(text);
        totalLength += text.length;
      }
    }
  });

  return {
    sections,
    links: processRelatedLinks($)
  };
}

// 更新主处理函数
export async function processMCMODContent(url: string, config: ModwikiConfig): Promise<ProcessResult> {
  try {
    const response = await axios.get(url, {
      timeout: config.pageTimeout * 1000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    if ($('.class-404').length > 0) {
      throw new Error('页面不存在');
    }

    // 确定页面类型
    const pageType = url.includes('/modpack/') ? 'modpack'
                   : url.includes('/post/') ? 'post'
                   : url.includes('/item/') ? 'item'
                   : 'mod';

    const content = processPageContent($, pageType, config.totalPreviewLength);

    // 组织返回结果
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
