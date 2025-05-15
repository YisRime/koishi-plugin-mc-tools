import { Context, Session, h, Element } from 'koishi'
import { Config } from '../index'

/**
 * 对指定URL进行网页截图
 * @param {string} url - 要截图的网页URL
 * @param {Context} ctx - Koishi上下文
 * @returns {Promise<h.Element|null>} 截图的图片元素，失败则返回null
 */
async function takeScreenshot(url: string, ctx: Context): Promise<Element|null> {
  try {
    const browser = await ctx.puppeteer.browser
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    try {
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
      const bodyHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 800))
      if (bodyHeight > 900) await page.setViewport({ width: 1280, height: Math.min(bodyHeight, 8000), deviceScaleFactor: 1 })
      const image = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true })
      if (image) return h.image(image, 'image/jpeg')
      return null
    } finally {
      await context.close()
    }
  } catch (e) {
    ctx.logger.error('渲染截图失败:', e)
    return null
  }
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
    const screenshotResult = await takeScreenshot(url, ctx)
    if (screenshotResult) return screenshotResult
  }
  if (config.useForward && session.platform === 'onebot') {
    try {
      const messages = content.map(item => ({
        type: 'node',
        data: {
          name: 'MC Tools', uin: session.selfId,
          content: typeof item === 'object' && item?.type === 'img'
            ? `[CQ:image,file=${item.attrs?.src || ''}]`
            : item
        }
      }))
      const isGroup = session.guildId || (session.subtype === 'group')
      const target = isGroup ? (session.guildId || session.channelId) : session.channelId
      const method = isGroup ? 'sendGroupForwardMsg' : 'sendPrivateForwardMsg'
      try {
        await session.bot.internal[method](target, messages)
        return ''
      } catch (error) {
        ctx.logger.error('消息合并转发失败:', error)
        for (const item of content) await session.send(item)
        return ''
      }
    } catch (error) {
      ctx.logger.error('消息处理失败:', error)
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