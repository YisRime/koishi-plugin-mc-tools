import { Context, Session, h, Element } from 'koishi'
import { Config } from '../index'

/**
 * 对指定URL进行网页截图，只截取主要内容区域
 * @param {string} url - 需要截图的URL地址
 * @param {Context} ctx - Koishi上下文对象，用于获取puppeteer实例
 * @param {Function} [onImageCallback] - 可选的回调函数，用于处理截图后的图片元素
 * @returns {Promise<Element|null>} 返回图片元素或null（如截图失败）
 */
async function takeScreenshot(url: string, ctx: Context, onImageCallback?: (image: Element) => Promise<void>): Promise<Element|null> {
  try {
    const browser = await ctx.puppeteer.browser
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    try {
      // 设置请求拦截
      await page.setRequestInterception(true)
      page.on('request', (request) => {
        const resourceType = request.resourceType()
        const requestUrl = request.url().toLowerCase()
        // 拦截判断
        if ((requestUrl.includes('at.alicdn.com') && (requestUrl.endsWith('.js') || requestUrl.includes('font_'))) ||
            (requestUrl.includes('iconfont') && requestUrl.includes('.svg'))) {
          request.continue()
        } else if (['image', 'media', 'font', 'script'].includes(resourceType) &&
                   /\.(gif|analytics|tracking|ad|pixel)|\/ad(s|vert(ising)?)?\/|(pagead2\.googlesyndication|adservice\.google|amazon-adsystem|googletagmanager|scorecardresearch)\.com/.test(requestUrl)) {
          request.abort()
        } else {
          request.continue()
        }
      })
      // 加载页面并等待内容就绪
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
      await page.evaluate(() => new Promise(resolve => {
        document.readyState === 'complete' ? resolve(true) :
          window.addEventListener('load', () => resolve(true), { once: true });
        setTimeout(resolve, 5000);
      }))
      // 优化页面并截图
      await optimizePage(page, url)
      const contentBox = await getContentBox(page)
      return await captureScreenshots(page, contentBox, onImageCallback)
    } finally {
      await context.close()
    }
  } catch (e) {
    ctx.logger.error(`渲染截图失败: ${e.message}`, e)
    return null
  }
}

/**
 * 获取页面的主要内容区域
 * @param {Object} page - Puppeteer页面对象
 * @returns {Promise<Object|null>} 返回内容区域的位置和尺寸信息，包含x、y、width和height属性，如果无法确定则返回null
 */
async function getContentBox(page) {
  const url = page.url()
  return await page.evaluate((currentUrl) => {
    // 基于URL确定主要内容区域的选择器
    const siteMap = {
      'mcmod.cn': ['.item-row', '.post-row', '.class-text'],
      'modrinth.com': ['.new-page.sidebar', '.markdown-body', '.project-description'],
      'minecraft.wiki': ['#bodyContent', '#content']
    }
    // 确定当前网站的选择器并添加通用选择器
    const selectors = Object.entries(siteMap).find(([site]) => currentUrl.includes(site))?.[1] || []
    selectors.push('main', '.content')
    // 查找第一个有效元素
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      if (element) {
        const rect = element.getBoundingClientRect()
        return {
          x: Math.max(0, rect.left),  y: Math.max(0, rect.top),
          width: Math.min(rect.width, window.innerWidth),  height: rect.height
        }
      }
    }
    return null
  }, url)
}

/**
 * 根据内容区域截取图片，支持处理超高内容的分段截图
 * @param {Object} page - Puppeteer页面对象
 * @param {Object} contentBox - 页面内容区域的位置和尺寸
 * @param {Function} [onImageCallback] - 可选的回调函数，用于处理截图后的图片元素
 * @returns {Promise<Element|null>} 返回图片元素或null（如截图失败或使用回调处理）
 */
async function captureScreenshots(page, contentBox, onImageCallback?: (image: Element) => Promise<void>): Promise<Element|null> {
  if (!contentBox) return null
  const maxHeight = 4096
  const screenshotOpts = { type: 'webp', quality: 80, optimizeForSpeed: true, omitBackground: true }
  // 单次截图处理
  if (contentBox.height <= maxHeight) {
    const image = await page.screenshot({ ...screenshotOpts, clip: contentBox })
    if (!image) return null
    const imageElement = h.image(image, 'image/webp')
    if (onImageCallback) {
      await onImageCallback(imageElement)
      return null
    }
    return imageElement
  }
  // 分页截图处理
  const pageCount = Math.ceil(contentBox.height / maxHeight)
  const screenshots = await Promise.all(
    Array(pageCount).fill(0).map(async (_, i) => {
      const startY = contentBox.y + i * maxHeight
      const height = Math.min(maxHeight, contentBox.height - (i * maxHeight))
      const image = await page.screenshot({
        ...screenshotOpts, clip: { x: contentBox.x, y: startY, width: contentBox.width, height }
      })
      return { image, index: i }
    })
  )
  // 按索引排序并处理图片
  for (const { image, index } of screenshots.sort((a, b) => a.index - b.index)) {
    if (image) {
      const imageElement = h.image(image, 'image/webp')
      if (onImageCallback) {
        await onImageCallback(imageElement)
      } else if (index === 0) {
        return imageElement
      }
    }
  }
  return null
}

/**
 * 基于URL优化页面显示效果，移除不必要元素并调整样式
 * @param {Object} page - Puppeteer页面对象
 * @param {string} url - 页面URL地址，用于确定网站类型
 * @returns {Promise<void>}
 */
async function optimizePage(page, url: string) {
  const siteType = url.includes('mcmod.cn') ? 'mcmod' :
                  url.includes('minecraft.wiki') ? 'minecraft-wiki' :
                  url.includes('modrinth.com') ? 'modrinth' : 'generic'
  await page.evaluate((type) => {
    // 通用选择器与站点特定选择器
    const selectorsToRemove = [
      'footer', 'header', 'nav', '.ads-container', 'ins.adsbygoogle', 'iframe', 'script',
      ...(type === 'mcmod' ? ['.comment-ad', '.class-rating-submit'] : []),
      ...(type === 'minecraft-wiki' ? [
        '.mw-editsection', '.noprint', '.mw-indicators', '#siteNotice',
        '#mw-page-base', '#mw-head-base', '.wiki-nav', '.page-header',
        '#mw-head', '#mw-navigation', '.mcw-sidebar'
      ] : []),
      ...(type === 'modrinth' ? [
        '.notification-container', '.vue-notification-group', '.project-description + div',
        '.joined-buttons', '.donate-button', '.social-buttons', '.btn-group',
        '.sidebar-left', '.sidebar-right', '.header-wrapper'
      ] : [])
    ]
    // 移除不需要的元素
    selectorsToRemove.forEach(selector => { document.querySelectorAll(selector).forEach(el => el?.remove()) })
    // 站点特定处理
    if (type === 'mcmod') {
      document.querySelectorAll('.uknowtoomuch').forEach(el => {
        if (el.parentNode) {
          const newElement = document.createElement('span')
          newElement.textContent = el.textContent
          el.parentNode.replaceChild(newElement, el)
        }
      })
    } else if (type === 'minecraft-wiki') {
      document.querySelectorAll('.collapsible').forEach(el => {
        el.classList.remove('collapsed')
        el.classList.add('expanded')
      })
    } else if (type === 'modrinth') {
      document.querySelectorAll('details').forEach(detail => detail.setAttribute('open', 'true'))
      document.querySelectorAll('img').forEach(img => {
        img.loading = 'eager'
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src }
      })
    }
  }, siteType)
}

/**
 * 渲染并输出内容，支持普通文本、图片和合并转发等多种方式
 * @param {Session} session - Koishi会话对象
 * @param {any[]} content - 要输出的内容数组
 * @param {string|null} url - 相关URL，用于截图模式
 * @param {Context} ctx - Koishi上下文
 * @param {Config} config - 配置对象
 * @param {boolean} screenshot - 是否使用截图模式
 * @returns {Promise<string|any>} 处理结果
 */
export async function renderOutput(session: Session, content: any[], url: string = null,
  ctx: Context, config: Config, screenshot: boolean = false) {
  if (!content?.length) return ''
  if (config.useScreenshot && screenshot && url && ctx.puppeteer) {
    try {
      const screenshotResult = await takeScreenshot(url, ctx, async (image) => { await session.send(image) })
      return screenshotResult || '';
    } catch (error) {
      ctx.logger.error('截图失败:', error)
      if (config.useFallback) {
        for (const item of content) await session.send(item)
        return ''
      } else {
        await session.send('截图失败')
      }
    }
  }
  if (config.useForward && session.platform === 'onebot') {
    try {
      const messages = content.map(item => ({
        type: 'node',
        data: {
          name: 'MC Tools', uin: session.selfId,
          content: typeof item === 'object' && item?.type === 'img'
            ? `[CQ:image,file=${item.attrs?.src || ''}]` : item
        }
      }))
      const isGroup = session.guildId || (session.subtype === 'group')
      const target = isGroup ? (session.guildId || session.channelId) : session.channelId
      const method = isGroup ? 'sendGroupForwardMsg' : 'sendPrivateForwardMsg'
      await session.bot.internal[method](target, messages)
      return ''
    } catch (error) {
      ctx.logger.error('消息合并转发失败:', error)
      if (config.useFallback) {
        for (const item of content) await session.send(item)
        return ''
      } else {
        await session.send('合并转发失败')
      }
    }
  } else {
    try {
      for (const item of content) await session.send(item)
      return ''
    } catch (error) {
      ctx.logger.error('消息发送失败:', error)
    }
  }
  return content
}
