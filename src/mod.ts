import { Context, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MTConfig } from './index'
import { SearchResult } from './wiki'
import { capture } from './shot'

interface ProcessResult {
  sections: string[];
  links: string[];
}
interface SearchModResult {
  source: 'modrinth' | 'curseforge'
  id: string | number
  type: string
  title: string
  description: string
  categories: string[]
}

const TypeMap = {
  modrinthTypes: {
    'mod': '模组',
    'resourcepack': '资源包',
    'datapack': '数据包',
    'shader': '光影',
    'modpack': '整合包',
    'plugin': '插件'
  },
  facets: {
    'mod': ['project_type:mod'],
    'resourcepack': ['project_type:resourcepack'],
    'datapack': ['project_type:datapack'],
    'shader': ['project_type:shader'],
    'modpack': ['project_type:modpack'],
    'plugin': ['project_type:plugin']
  } as const,
  curseforgeTypes: {
    6: 'mod',
    12: 'resourcepack',
    17: 'modpack',
    4471: 'shader',
    4546: 'datapack',
    4944: 'world',
    5141: 'addon',
    5232: 'plugin',
  },
  curseforgeTypeNames: {
    'mod': '模组/扩展',
    'resourcepack': '资源包/材质包',
    'modpack': '整合包',
    'shader': '光影包',
    'datapack': '数据包',
    'world': '地图存档',
    'addon': '附加内容',
    'plugin': '服务器插件'
  },
  getTypeInfo(source: 'modrinth' | 'curseforge', type?: string) {
    if (!type) return { valid: true };
    const types = source === 'modrinth'
      ? Object.keys(this.modrinthTypes)
      : Object.values(this.curseforgeTypes);
    return {
      valid: types.includes(type),
      facets: source === 'modrinth' ? [`project_type:${type}`] : undefined,
      classId: source === 'curseforge'
        ? Number(Object.keys(this.curseforgeTypes).find(k => this.curseforgeTypes[k] === type))
        : undefined
    };
  },
  getLocalizedType(source: 'modrinth' | 'curseforge', typeKey: string | number) {
    return source === 'modrinth'
      ? this.modrinthTypes[typeKey] || typeKey
      : this.curseforgeTypeNames[this.curseforgeTypes[typeKey]] || '未知';
  }
}

// 内容解析
function parseContent($: cheerio.CheerioAPI, pageType: 'mod' | 'modpack' | 'post' | 'item' | 'bbs', maxLength: number): ProcessResult {
  const sections: string[] = []
  const relatedLinks: string[] = []
  let totalLength = 0
  const parseImage = ($elem: cheerio.Cheerio<any>): string | null => {
    const $img = $elem.find('img')
    const src = $img.attr('data-src') || $img.attr('src')
    return src ? h.image(src.startsWith('//') ? `https:${src}` : src).toString() : null
  }
  const parseLink = ($elem: cheerio.Cheerio<any>): string | null => {
    const links: string[] = []
    $elem.find('[id^="link_"]').each((_, elem) => {
      const $link = $(elem)
      const id = $link.attr('id')
      if (!id) return
      const scriptContent = $(`script:contains(${id})`).text()
      const urlMatch = scriptContent.match(/content:"[^"]*?<strong>([^<]+)/)
      if (urlMatch?.[1]) {
        const url = urlMatch[1]
        if (url.match(/\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif)$/i)) return
        let prefix = ''
        let prevNode = $link[0].previousSibling
        while (prevNode && prevNode.type === 'text') {
          prefix = prevNode.data.trim() + ' ' + prefix
          prevNode = prevNode.previousSibling
        }
        prefix = prefix.trim()
        const linkText = $link.text().trim()
        const isUrl = linkText.match(/^https?:\/\//)
        const formattedLink = isUrl ? url : `[${linkText}](${url})`
        links.push(prefix ? `${prefix} ${formattedLink}` : formattedLink)
      }
    })
    return links.length > 0 ? links.join('\n') : null
  }
  const parseText = ($elem: cheerio.Cheerio<any>): string | null => {
    const cleanedElem = $elem.clone()
    cleanedElem.find('script, i.pstatus, .fastcopy').remove()
    // 处理链接
    cleanedElem.find('a').each((_, link) => {
      const $link = $(link)
      const href = $link.attr('href')
      const text = $link.text().trim()
      if (href && text && !href.includes('javascript:') && !href.startsWith('#')) {
        let processedHref = href
        if (href.startsWith('//')) {
          processedHref = `https:${href}`
        } else if (href.startsWith('/')) {
          processedHref = `https://www.mcmod.cn${href}`
        }
        let prefix = ''
        let prevNode = link.previousSibling
        while (prevNode && prevNode.type === 'text') {
          prefix = prevNode.data.trim() + ' ' + prefix
          prevNode.data = ''
          prevNode = prevNode.previousSibling
        }
        const isUrl = text.match(/^https?:\/\//)
        const markdownLink = isUrl ? processedHref : `[${text}](${processedHref})`
        const linkText = prefix ? `${prefix} ${markdownLink}` : markdownLink
        $link.replaceWith(linkText)
      }
    })
    const text = cleanedElem.text()
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]|\[(\w+)\]|本帖最后由.+编辑|复制代码/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const isTitle = () => {
      if (text.length > 12) return false
      const $parent = $elem.parent()
      return $parent.find('strong').length || $parent.find('span.common-text-title').length
    }
    return text && !text.includes('此链接会跳转到') && !text.includes('不要再提示我')
      ? (isTitle() ? `『${text}』` : text)
      : null
  }
  // 解析头部信息
  if (pageType === 'item') {
    const itemName = $('.itemname .name h5').first().text().trim()
    const title = itemName || $('.class-title h3').first().text().trim() +
      ($('.class-title h4').first().text().trim() ? ` (${$('.class-title h4').first().text().trim()})` : '')
    sections.push(title)
    const $itemIcon = $('.item-info-table')
    if ($itemIcon.length) {
      const image = parseImage($itemIcon)
      if (image) sections.push(image)
    }
  } else if (['mod', 'modpack'].includes(pageType)) {
    // 标题和封面
    const shortName = $('.short-name').first().text().trim()
    const title = $('.class-title h3').first().text().trim()
    const enTitle = $('.class-title h4').first().text().trim()
    const modStatusLabels = $(`.class-official-group .class-status`).map((_, el) => $(el).text().trim()).get()
      .concat($(`.class-official-group .class-source`).map((_, el) => $(el).text().trim()).get())
    sections.push(`${shortName} ${enTitle} | ${title}${
      modStatusLabels.length ? ` (${modStatusLabels.join(' | ')})` : ''
    }`)
    const $coverImage = $('.class-cover-image')
    if ($coverImage.length) {
      const imageResult = parseImage($coverImage)
      if (imageResult) sections.push(imageResult)
    }
    // 信息块
    $('.class-info-left .col-lg-4').each((_, elem) => {
      const text = $(elem).text().trim().replace(/\s+/g, ' ').replace(/：/g, ':')
      if (text.includes('支持的MC版本')) return
      const infoTypes = ['整合包类型', '运作方式', '打包方式', '运行环境']
      if (infoTypes.some(t => text.includes(t))) {
        sections.push(text)
      }
    })
    // 版本信息
    const versionSections = ['支持版本:']
    const processedLoaders = new Set<string>()
    $('.mcver ul').each((_, ul) => {
      const $ul = $(ul)
      const loader = $ul.find('li:first').text().trim()
      if (loader && !processedLoaders.has(loader)) {
        const versions = $ul.find('a')
          .map((_, el) => $(el).text().trim())
          .get()
          .filter(v => v.match(/^\d/))
        if (versions.length) {
          // 处理版本合并
          const grouped = versions.reduce((groups, version) => {
            const mainVersion = version.match(/^(\d+\.\d+)/)?.[1] || version
            groups.set(mainVersion, (groups.get(mainVersion) || []).concat(version))
            return groups
          }, new Map<string, string[]>())
          const processedVersions = Array.from(grouped.entries())
            .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
            .map(([main, group]) => group.length > 1 ? `${main}(${group.length}个版本)` : group[0])
          versionSections.push(`${loader} ${processedVersions.join(', ')}`)
          processedLoaders.add(loader)
        }
      }
    })
    if (versionSections.length > 1) {
      sections.push(...versionSections)
    }
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
  $content.children().each((_, element) => {
    const $elem = $(element)
    const image = parseImage($elem)
    if (image) {
      sections.push(image)
      return
    }
    const link = parseLink($elem)
    if (link) {
      sections.push(link)
      return
    }
    const text = parseText($elem)
    if (text && (maxLength < 0 || totalLength < maxLength)) {
      sections.push(text)
      if (!text.startsWith('http')) {
        totalLength += text.length
      }
    }
  })
  // 相关链接
  const linkMap = new Map<string, { url: string; name: string }>()
  $('.common-link-frame .list ul li').each((_, item) => {
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
  })
  Array.from(linkMap.entries()).forEach(([type, { url, name }]) => {
    relatedLinks.push(`${type}${name !== type ? ` (${name})` : ''}: ${url}`)
  })
  return {
    sections: sections.filter((s, i, arr) => s.trim() && arr.indexOf(s) === i),
    links: relatedLinks
  }
}

export function formatContent(result: ProcessResult, url: string, options: {
  linkCount?: number,
  showImages?: 'always' | 'noqq' | 'never',
  platform?: string
} = {}): string {
  if (!result?.sections) {
    return `无法获取页面内容，请访问：${url}`
  }
  const sections = result.sections.filter(Boolean).map(section =>
    section.toString().trim()
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
  )
  // 对内容进行分类整理
  const title = sections[0]
  const coverImage = sections[1]
  const basicInfo = sections.filter(s =>
    ['运行环境', '整合包类型', '运作方式', '打包方式'].some(type => s.includes(type)))
  const versionInfo = sections.filter(s =>
    s === '支持版本:' || ['行为包:', 'Forge:', 'Fabric:'].some(type => s.includes(type)))
  const content = sections.filter((s, index) =>
    index > 1 &&
    !['运行环境', '整合包类型', '运作方式', '打包方式'].some(type => s.includes(type)) &&
    !['支持版本:', '行为包:', 'Forge:', 'Fabric:'].some(type => s.includes(type))
  ).map((s, i, arr) => {
    const noLimit = options.linkCount === -1;
    if (i === arr.length - 1 && !s.startsWith('http') && !s.endsWith('...') && !options.linkCount && !noLimit) {
      return s + '...'
    }
    return s
  })
  const images = sections.filter((s, index) =>
    index > 1 && s.startsWith('http') && !s.includes(':'))
  // 相关链接
  const linkLimit = options.linkCount === -1 ? Infinity : (options.linkCount || 0);
  const links = result.links?.length
    ? ['相关链接:', ...result.links.slice(0, linkLimit)]
    : []
  // 判断是否显示图片
  const shouldShowImages =
    options.showImages === 'always' ||
    (options.showImages === 'noqq' && options.platform !== 'qq')
  // 最终输出
  const output = [
    title,
    coverImage,
    ...basicInfo,
    ...versionInfo,
    ...(links.length ? links : []),
    '简介:',
    ...content,
    ...(shouldShowImages ? images : []),
    `详细内容: ${url}`
  ]
  return output
    .filter(s => s && s.length > 0)
    .join('\n')
    .trim() || `无法获取详细内容，请访问：${url}`
}

export async function fetchModContent(url: string, config: MTConfig): Promise<ProcessResult> {
  try {
    const response = await axios.get(url, {
      timeout: config.Timeout < 0 ? 0 : config.Timeout * 1000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const $ = cheerio.load(response.data)
    if ($('.class-404').length > 0) {
      throw new Error('该页面不存在或已被删除')
    }
    const pageType = url.includes('/modpack/') ? 'modpack'
                   : url.includes('/post/') ? 'post'
                   : url.includes('/item/') ? 'item'
                   : url.includes('bbs.mcmod.cn') ? 'bbs'
                   : 'mod'
    return parseContent($, pageType, config.totalLength)
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.code === 'ECONNABORTED'
        ? '请求超时，请稍后再试'
        : `内容获取失败：${error.message}`)
    }
    throw error
  }
}

/**
 * MCMOD 搜索
 * @param {string} keyword - 搜索关键词
 * @param {MTConfig} config - Minecraft工具配置
 * @returns {Promise<SearchResult[]>} 搜索结果列表
 * @throws {Error} 搜索失败时抛出错误
 */
export async function searchMod(keyword: string, config: MTConfig): Promise<SearchResult[]> {
  try {
    const response = await axios.get(
      `https://search.mcmod.cn/s?key=${encodeURIComponent(keyword)}`,
      { timeout: config.Timeout < 0 ? 0 : config.Timeout * 1000 }
    );
    const $ = cheerio.load(response.data);

    const results: SearchResult[] = []
    $('.result-item').each((_, item) => {
      const $item = $(item)
      const titleEl = $item.find('.head a').last()
      const title = titleEl.text().trim()
      const url = titleEl.attr('href') || ''
      let desc = '';
      if (config.descLength !== 0) {
        desc = $item.find('.body').text().trim().replace(/\[.*?\]/g, '').trim();
        if (config.descLength > 0 && desc.length > config.descLength) {
          desc = desc.slice(0, config.descLength) + '...';
        }
      }

      const normalizedUrl = url.startsWith('http') ? url : `https://www.mcmod.cn${url}`

      if (title && url) {
        results.push({
          title,
          url: normalizedUrl,
          desc,
          source: 'mcmod'
        })
      }
    })
    return results.slice(0, 10)
  } catch (error) {
    throw new Error(`搜索失败: ${error.message}`)
  }
}

/**
 * 处理游戏版本列表，过滤快照并合并相似版本
 */
function processGameVersions(versions: string[]): string[] {
  if (!versions?.length) return [];
  // 分离正式版和快照版
  const [stableVersions, snapshotCount] = versions.reduce<[string[], number]>(([stable, count], version) => {
    const isSnapshot = version.includes('exp') || version.includes('pre') ||
                      version.includes('rc') || /\d+w\d+[a-z]/.test(version);
    return isSnapshot ? [stable, count + 1] : [[...stable, version], count];
  }, [[], 0]);
  // 按主版本号分组
  const grouped = stableVersions.reduce((groups, version) => {
    const mainVersion = version.match(/^(\d+\.\d+)/)?.[1] || version;
    groups.set(mainVersion, (groups.get(mainVersion) || []).concat(version));
    return groups;
  }, new Map<string, string[]>());
  // 格式化输出
  const result = Array.from(grouped.entries())
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .map(([main, group]) => group.length > 1 ? `${main}(${group.length}个版本)` : group[0]);
  if (snapshotCount > 0) result.push(`+${snapshotCount}个快照版本`);
  return result;
}

/**
 * 统一API请求函数
 */
async function fetchAPI(url: string, options: any = {}) {
  try {
    const response = await axios({
      url,
      ...options,
      timeout: (options.timeout || 10) * 1000
    });
    return response.data;
  } catch (error) {
    throw new Error(`请求失败: ${error.message}`);
  }
}

/**
 * 统一搜索函数
 */
async function searchMods(
  keyword: string,
  source: 'modrinth' | 'curseforge',
  config: MTConfig,
  cfApiKey?: string,
  type?: string
): Promise<SearchModResult[]> {
  const typeInfo = TypeMap.getTypeInfo(source, type);
  if (!typeInfo.valid) throw new Error(`无效的类型: ${type}`);
  if (source === 'modrinth') {
    const data = await fetchAPI('https://api.modrinth.com/v2/search', {
      params: {
        query: keyword,
        limit: 10,
        facets: typeInfo.facets ? [typeInfo.facets] : undefined,
        offset: 0,
        index: 'relevance'
      },
      timeout: config.Timeout < 0 ? 0 : config.Timeout
    });
    return data.hits.map(hit => ({
      source: 'modrinth' as const,
      id: hit.slug,
      type: hit.project_type,
      title: hit.title,
      description: hit.description,
      categories: hit.categories
    }));
  } else {
    const data = await fetchAPI('https://api.curseforge.com/v1/mods/search', {
      headers: { 'x-api-key': cfApiKey },
      params: {
        gameId: 432,
        searchFilter: keyword,
        classId: typeInfo.classId,
        pageSize: 10,
        sortField: 2,
        sortOrder: 'desc'
      },
      timeout: config.Timeout < 0 ? 0 : config.Timeout
    });
    return data.data.map(r => ({
      source: 'curseforge' as const,
      id: r.id,
      type: TypeMap.curseforgeTypes[r.classId] || '未知',
      title: r.name,
      description: r.summary,
      categories: r.categories.map(c => typeof c === 'string' ? c : c.name)
    }));
  }
}

/**
 * 获取项目详情
 */
async function getModDetails(
  result: SearchModResult,
  config: MTConfig,
  cfApiKey?: string
): Promise<string> {
  let details, displayType;
  if (result.source === 'modrinth') {
    // 获取Modrinth详情
    const data = await fetchAPI(`https://api.modrinth.com/v2/project/${result.id}`);
    details = {
      title: data.title,
      description: data.body,
      type: data.project_type,
      categories: data.categories,
      requirements: [
        `客户端: ${data.client_side === 'required' ? '必需' : data.client_side === 'optional' ? '可选' : '无需'}`,
        `服务端: ${data.server_side === 'required' ? '必需' : data.server_side === 'optional' ? '可选' : '无需'}`
      ],
      loaders: data.loaders,
      versions: processGameVersions(data.game_versions),
      url: `https://modrinth.com/${data.project_type}/${data.slug}`
    };
    displayType = TypeMap.getLocalizedType('modrinth', data.project_type);
  } else {
    // 获取CurseForge详情
    const data = await fetchAPI(`https://api.curseforge.com/v1/mods/${result.id}`, {
      headers: { 'x-api-key': cfApiKey }
    });
    const descData = await fetchAPI(`https://api.curseforge.com/v1/mods/${result.id}/description`, {
      headers: { 'x-api-key': cfApiKey }
    });
    // 提取版本和加载器信息
    const allVersions = new Set<string>();
    const loaders = new Set<string>();
    data.data.latestFiles?.forEach(file => {
      file.gameVersions?.forEach(version => {
        if (version.includes('Forge') || version.includes('Fabric') ||
            version.includes('NeoForge') || version.includes('Quilt')) {
          loaders.add(version.split('-')[0]);
        } else {
          allVersions.add(version);
        }
      });
    });
    details = {
      title: data.data.name,
      description: descData.data.replace(/<[^>]*>/g, '').replace(/\n\s*\n/g, '\n'),
      type: data.data.classId,
      categories: data.data.categories.map(c => typeof c === 'string' ? c : c.name),
      requirements: [],
      loaders: Array.from(loaders),
      versions: processGameVersions(Array.from(allVersions)),
      url: data.data.links.websiteUrl
    };
    displayType = TypeMap.getLocalizedType('curseforge', data.data.classId);
  }
  // 格式化描述
  let description = details.description;
  if (config.totalLength > 0 && description.length > config.totalLength) {
    description = description.slice(0, config.totalLength) + '...';
  }
  // 构建输出
  const parts = [
    `${displayType} | ${details.title}（${details.categories.join(', ')}）`,
    details.requirements.length ? details.requirements.join(' | ') : '',
    details.loaders?.length ? `加载器: ${details.loaders.join(', ')}` : '',
    details.versions?.length ? `支持版本: ${details.versions.join(', ')}` : '',
    `详细介绍:\n${description}`,
    `链接: ${details.url}`
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 注册命令处理函数
 */
function registerModPlatform(mcmod: any, config: MTConfig) {
  mcmod.subcommand('.mr <keyword> [type]', '查询 Modrinth')
    .usage('mc.mod.mr <关键词> [类型] - 查询 Modrinth 内容\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({}, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'modrinth', config, config.cfApi, type);
        if (!results.length) return '未找到相关内容';
        return await getModDetails(results[0], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    })
    .subcommand('.find <keyword> [type]', '搜索 Modrinth')
    .usage('mc.mod.findmr <关键词> [类型] - 搜索 Modrinth 项目\n可用类型：mod(模组), resourcepack(资源包), datapack(数据包), shader(光影), modpack(整合包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'modrinth', config, config.cfApi, type);
        if (!results.length) return '未找到相关项目';
        const formattedResults = results.map((r, i) => {
          let description = r.description;
          if (config.descLength > 0 && description.length > config.descLength) {
            description = description.slice(0, config.descLength) + '...';
          }
          return `${i + 1}. ${[
            `${TypeMap.getLocalizedType(r.source, r.type)} | ${r.title}`,
            `分类: ${r.categories.join(', ')}`,
            `描述: ${description}`
          ].join('\n')}`;
        }).join('\n');
        await session.send(`Modrinth 搜索结果：\n${formattedResults}\n请回复序号查看详细内容`);
        const response = await session.prompt(config.Timeout < 0 ? undefined : config.Timeout * 1000);
        if (!response) return '操作超时';
        const index = parseInt(response) - 1;
        if (isNaN(index) || index < 0 || index >= results.length) return '请输入有效的序号';
        return await getModDetails(results[index], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    });
  mcmod.subcommand('.cf <keyword> [type]', '查询 CurseForge')
    .usage('mc.mod.cf <关键词> [类型] - 查询 CurseForge 内容\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({}, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'curseforge', config, config.cfApi, type);
        if (!results.length) return '未找到相关内容';
        return await getModDetails(results[0], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    })
    .subcommand('.find <keyword> [type]', '搜索 CurseForge')
    .usage('mc.mod.findcf <关键词> [类型] - 搜索 CurseForge 项目\n可用类型：mod(模组), resourcepack(资源包), modpack(整合包), shader(光影), datapack(数据包), world(地图), addon(附加包), plugin(插件)')
    .action(async ({ session }, keyword, type) => {
      if (!keyword) return '请输入要搜索的关键词';
      try {
        const results = await searchMods(keyword, 'curseforge', config, config.cfApi, type);
        if (!results.length) return '未找到相关项目';
        const formattedResults = results.map((r, i) => {
          const description = r.description.length > config.descLength
            ? r.description.slice(0, config.descLength) + '...'
            : r.description;
          return `${i + 1}. ${[
            `${TypeMap.getLocalizedType(r.source, r.type)} | ${r.title}`,
            `分类: ${r.categories.join(', ')}`,
            `描述: ${description}`
          ].join('\n')}`;
        }).join('\n');
        await session.send(`CurseForge 搜索结果：\n${formattedResults}\n请回复序号查看详细内容`);
        const response = await session.prompt(config.Timeout * 1000);
        if (!response) return '操作超时';
        const index = parseInt(response) - 1;
        if (isNaN(index) || index < 0 || index >= results.length) return '请输入有效的序号';
        return await getModDetails(results[index], config, config.cfApi);
      } catch (error) {
        return error.message;
      }
    });
}

/**
 * 注册 Minecraft Mod 相关命令
 * @param {Context} ctx - Koishi上下文
 * @param {Command} parent - 父命令
 * @param {MTConfig} config - 插件配置
 */
export function registerMod(ctx: Context, parent: any, config: MTConfig) {
  const mcmod = parent.subcommand('.mod <keyword:text>', '查询 Minecraft 相关资源')
    .usage('mc.mod <关键词> - 查询 MCMod\nmc.mod.find <关键词> - 搜索 MCMod\nmc.mod.shot <关键词> - 截图 MCMod 页面\nmc.mod.(find)mr <关键词> [类型] - 搜索 Modrinth\nmc.mod.(find)cf <关键词> [类型] - 搜索 CurseForge')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'
      try {
        const results = await searchMod(keyword, config)
        if (!results.length) return '未找到相关内容'
        const content = await fetchModContent(results[0].url, config)
        return formatContent(content, results[0].url, {
          linkCount: config.linkCount,
          showImages: config.showImages,
          platform: session.platform
        })
      } catch (error) {
        return error.message
      }
    })
  mcmod.subcommand('.find <keyword:text>', '搜索 MCMod')
    .usage('mc.mod.find <关键词> - 搜索 MCMOD 页面')
    .action(async ({ session }, keyword) => {
      const { search } = await import('./wiki')
      return await search({
        keyword,
        source: 'mcmod',
        session,
        config,
        ctx
      })
    })
  mcmod.subcommand('.shot <keyword:text>', '截图 MCMod 页面')
    .usage('mc.mod.shot <关键词> - 搜索并获取指定页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要查询的关键词'
      try {
        const results = await searchMod(keyword, config)
        if (!results.length) throw new Error('未找到相关内容')
        const targetUrl = results[0].url
        await session.send(`正在获取页面...\n完整内容：${targetUrl}`)
        const result = await capture(
          targetUrl,
          ctx,
          { type: 'mcmod' },
          config
        )
        return result.image
      } catch (error) {
        return error.message
      }
    })
  registerModPlatform(mcmod, config)
}