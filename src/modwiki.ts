import { h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { ModwikiConfig } from './utils'

interface ProcessResult {
  sections: string[];
  links: string[];
}

interface ContentResult {
  title: string;
  coverImage?: string;
  basicInfo: string[];
  versions: string[];
  mainContent: string[];
  contentImages: string[];
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
function processBasicInfo($: cheerio.CheerioAPI, isModpack: boolean): string[] {
  const sections: string[] = [];
  const shortName = $('.short-name').first().text().trim();
  const title = $('.class-title h3').first().text().trim();
  const enTitle = $('.class-title h4').first().text().trim();

  const modStatusLabels = !isModpack ? [
    ...$(`.class-official-group .class-status`).map((_, el) => $(el).text().trim()).get(),
    ...$(`.class-official-group .class-source`).map((_, el) => $(el).text().trim()).get()
  ] : [];

  sections.push(`${shortName} ${enTitle} | ${title}${
    !isModpack && modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''
  }`);

  // 处理封面图片
  const $coverImage = $('.class-cover-image img').first();
  if ($coverImage.length) {
    sections.push(...processImage($, $coverImage, []));
  }

  // 处理信息 - 排除版本信息
  $('.class-info-left .col-lg-4').each((_, elem) => {
    const text = cleanText($(elem).text()).replace(/：/g, ':');
    // 跳过版本信息相关内容
    if (text.includes('支持的MC版本')) return;

    const shouldInclude = isModpack
      ? ['整合包类型', '运作方式', '打包方式'].some(t => text.includes(t))
      : text.includes('运行环境');

    if (shouldInclude) {
      sections.push(text);
    }
  });

  return sections;
}

function processVersionInfo($: cheerio.CheerioAPI, isModpack: boolean): string[] {
  const sections: string[] = ['支持版本:'];
  const processedLoaders = new Set<string>(); // 用于追踪已处理的加载器

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
        processedLoaders.add(loader); // 记录已处理的加载器
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
    /^[\u4e00-\u9fa5\w\s]+$/  // 匹配中文、字母、数字和空格组成的标题
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

  // 根据title判断是否为物品页面
  const isItemPage = sections[0]?.match(/^.+?\s*\([^)]+?\)$/); // 匹配形如 "物品名 (英文名)" 的格式

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
    // 相关链接 - 仅在非物品页面显示
    ...(!isItemPage ? [
      '相关链接:',
      ...(result.links || []),
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
function processPageContent($: cheerio.CheerioAPI, pageType: 'mod' | 'modpack' | 'post' | 'item', maxLength: number): ContentResult {
  const result: ContentResult = {
    title: '',
    coverImage: '',
    basicInfo: [],
    versions: [],
    mainContent: [],
    contentImages: [],
    links: []
  };

  if (pageType === 'item') {
    // 从.itemname区块获取物品名称
    const itemName = $('.itemname .name h5').first().text().trim();
    if (itemName) {
      result.title = itemName;
    } else {
      // 后备方案：如果找不到.itemname，则从class-title获取
      const itemTitle = $('.class-title h3').first().text().trim();
      const itemEnglishTitle = $('.class-title h4').first().text().trim();
      result.title = itemTitle + (itemEnglishTitle ? ` (${itemEnglishTitle})` : '');
    }

    // 处理物品图片
    const $itemIcon = $('.item-info-table img').first();
    if ($itemIcon.length) {
      const imgSrc = $itemIcon.attr('data-src') || $itemIcon.attr('src');
      if (imgSrc) {
        result.coverImage = imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc;
      }
    }

    // 基本信息部分只插入标题
    result.basicInfo = [result.title];
  } else if (pageType === 'mod' || pageType === 'modpack') {
    // 处理标题
    const shortName = $('.short-name').first().text().trim();
    const title = $('.class-title h3').first().text().trim();
    const enTitle = $('.class-title h4').first().text().trim();
    const modStatusLabels = pageType === 'mod' ? [
      ...$(`.class-official-group .class-status`).map((_, el) => $(el).text().trim()).get(),
      ...$(`.class-official-group .class-source`).map((_, el) => $(el).text().trim()).get()
    ] : [];

    result.title = `${shortName} ${enTitle} | ${title}${
      pageType === 'mod' && modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''
    }`;

    // 处理基本信息
    result.basicInfo = processBasicInfo($, pageType === 'modpack');
    result.versions = processVersionInfo($, pageType === 'modpack');
  }

  // 处理主要内容
  const contentSelector = {
    mod: '.common-text',
    modpack: '.common-text',
    post: 'div.text',
    item: '.item-content.common-text'
  }[pageType];

  // 处理正文内容，包括分离图片
  const state = { sections: [], totalLength: 0, maxLength };
  $(contentSelector).children().each((_, element) => {
    if (state.totalLength >= maxLength) return false;

    const $elem = $(element);

    // 处理图片元素
    if ($elem.find('.figure').length || $elem.is('.figure')) {
      const $img = $elem.find('img');
      const imgSrc = $img.attr('data-src') || $img.attr('src');
      if (imgSrc) {
        // 直接将图片添加到sections中
        state.sections.push(h.image(imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc).toString());
      }
    } else {
      // 处理文本内容
      const text = cleanText($elem.clone().find('script').remove().end().text());
      if (text) {
        state.sections.push(text);
        state.totalLength += text.length;
      }
    }
  });

  result.mainContent = state.sections;
  // 不再需要单独的contentImages数组
  result.contentImages = [];

  // 处理相关链接
  result.links = processRelatedLinks($);

  return result;
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
    const sections = [
      content.title,
      content.coverImage && h.image(content.coverImage).toString(),
      ...content.basicInfo,
      ...(content.versions.length ? ['', ...content.versions] : []),
      ...content.mainContent,
      ...content.contentImages.map(img => h.image(img).toString())
    ].filter(Boolean);

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
