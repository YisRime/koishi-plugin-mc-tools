import { Context, Schema, Session, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import {} from 'koishi-plugin-puppeteer'
import * as net from 'net';

export const name = 'mc-tools'

const LANGUAGES = {
  'zh': '简体中文',
  'en': 'English',
  'es': 'Español',
  'fr': 'Français',
  'de': 'Deutsch',
  'it': 'Italiano',
  'ja': '日本語',
  'ko': '한국어',
  'pl': 'Polski',
  'pt': 'Português',
  'ru': 'Русский',
  'th': 'ไทย',
  'tr': 'Türkçe'
} as const

type LangCode = keyof typeof LANGUAGES

export interface Config {
  defaultLang: LangCode
  viewportWidth: number
  viewportHeight: number
  timeout: number
  maxResults: number
  searchTimeout: number
  enableVersionNotify: boolean
  notifyGroups: string[]
  checkInterval: number
  defaultServers: Array<{
    name: string
    host: string
    port: number
  }>
}

export const Config: Schema<Config> = Schema.object({
  defaultLang: Schema.union(['zh', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'th', 'tr']).default('zh')
    .description('默认使用的语言'),
  viewportWidth: Schema.number().default(1280)
    .description('截图视窗宽度'),
  viewportHeight: Schema.number().default(4000)
    .description('截图视窗高度'),
  timeout: Schema.number().default(8000)
    .description('页面加载超时时间(ms)'),
  maxResults: Schema.number().default(10)
    .description('搜索结果最大显示数'),
  searchTimeout: Schema.number().default(10000)
    .description('搜索交互超时时间(ms)'),
  enableVersionNotify: Schema.boolean().default(false)
    .description('是否启用新版本通知'),
  notifyGroups: Schema.array(Schema.string())
    .description('接收新版本通知的群组ID列表')
    .default([]),
  checkInterval: Schema.number().default(3600000)
    .description('版本检查间隔(ms)，默认1小时'),
  defaultServers: Schema.array(Schema.object({
    name: Schema.string().description('服务器名称'),
    host: Schema.string().description('服务器地址'),
    port: Schema.number().description('服务器端口')
  })).default([]).description('默认的MC服务器列表')
})

export const inject = {
  required: ['puppeteer']
}

declare module 'koishi' {
  interface Events {
    'mcwiki-search-select'(results: any[], session: Session): void
  }
}

export function apply(ctx: Context, config: Config) {
  // 用户语言设置存储
  const userLangs = new Map<string, LangCode>()

  ctx.command('mcwiki.lang <lang>', '设置Wiki语言')
    .action(async ({ session }, lang: LangCode) => {
      if (!lang) {
        return `当前语言：${LANGUAGES[userLangs.get(session.userId) || config.defaultLang]}\n可用语言：${Object.entries(LANGUAGES).map(([code, name]) => `${code}(${name})`).join(', ')}`
      }
      if (!(lang in LANGUAGES)) {
        return '不支持的语言代码'
      }
      userLangs.set(session.userId, lang)
      return `已将Wiki语言设置为${LANGUAGES[lang]}`
    })

  ctx.command('mcwiki <keyword:text>', '查询Minecraft Wiki')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const lang = userLangs.get(session.userId) || config.defaultLang
        const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
        const searchUrl = `https://${domain}/w/${encodeURIComponent(keyword)}`
        const response = await axios.get(searchUrl)
        const $ = cheerio.load(response.data)

        // 获取主要内容区域的所有段落
        const paragraphs = $('#mw-content-text p')
          .filter((_, el) => $(el).text().trim() !== '')
          .map((_, el) => $(el).text().trim())
          .get()
          .join('\n\n')

        if (!paragraphs) {
          return '此页面目前没有内容。'
        }

        // 如果内容太长，只返回前600个字符
        const content = paragraphs.length > 600
          ? paragraphs.slice(0, 600) + '...'
          : paragraphs

        return `${content}\n\n链接：${searchUrl}`
      } catch (error) {
        return `查询失败：${error.message}`
      }
    })

  ctx.command('mcwiki.search <keyword:text>', '搜索Minecraft Wiki')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入搜索关键词'

      try {
        const lang = userLangs.get(session.userId) || config.defaultLang
        const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
        const searchUrl = `https://${domain}/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=${config.maxResults}`

        const [_, titles, descriptions, urls] = await axios.get(searchUrl).then(res => res.data)

        if (!titles.length) return '未找到相关结果'

        const results = titles.map((title, i) => ({
          title,
          description: descriptions[i],
          url: urls[i]
        }))

        let msg = '搜索结果:\n' + results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
        msg += '\n\n请输入序号查看对应页面'

        ctx.emit('mcwiki-search-select', results, session)
        return msg

      } catch (error) {
        return `搜索失败: ${error.message}`
      }
    })

  ctx.on('mcwiki-search-select', (results, session) => {
    const dispose = ctx.middleware((session2, next) => {
      if (session.userId !== session2.userId) return next()

      const num = parseInt(session2.content)
      if (isNaN(num) || num < 1 || num > results.length) {
        session.send('无效的序号，请重新输入')
        return
      }

      const result = results[num - 1]
      session.execute(`mcwiki.s ${result.title}`)
      dispose()
    })

    setTimeout(() => {
      session.send('搜索超时，已取消')
      dispose()
    }, config.searchTimeout)
  })

  ctx.command('mcwiki.shot <keyword:text>', '获取Minecraft Wiki页面截图')
    .action(async ({ session }, keyword) => {
      if (!keyword) return '请输入要搜索的关键词'

      try {
        const lang = userLangs.get(session.userId) || config.defaultLang
        const domain = lang === 'en' ? 'minecraft.wiki' : `${lang}.minecraft.wiki`
        const pageUrl = `https://${domain}/w/${encodeURIComponent(keyword)}`

        const context = await ctx.puppeteer.browser.createBrowserContext()
        const page = await context.newPage()

        await page.setViewport({
          width: config.viewportWidth,
          height: config.viewportHeight,
          deviceScaleFactor: 1
        })

        await page.goto(pageUrl, {
          waitUntil: 'networkidle0',
          timeout: config.timeout
        })

        await page.waitForSelector('#mw-content-text')
        const element = await page.$('#mw-content-text')
        const height = await element.evaluate(el => el.scrollHeight)

        const screenshot = await element.screenshot({
          type: 'png',
          clip: {
            x: 0,
            y: 0,
            width: config.viewportWidth,
            height: Math.min(height, config.viewportHeight)
          }
        })

        await context.close()

        if (height > config.viewportHeight) {
          await session.send(`页面过长，仅显示部分内容。完整页面: ${pageUrl}`)
        }

        return h.image(screenshot, 'image/png')

      } catch (error) {
        return `截图失败: ${error.message}`
      }
    })

  ctx.command('mcver', '获取Minecraft最新版本信息')
    .action(async () => {
      try {
        const response = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json')
        const { versions } = response.data

        const latest = versions[0]
        const latestRelease = versions.find(v => v.type === 'release')

        return `Minecraft 最新版本信息：
快照版：${latest.id} (${new Date(latest.releaseTime).toLocaleDateString()})
正式版：${latestRelease.id} (${new Date(latestRelease.releaseTime).toLocaleDateString()})`
      } catch (error) {
        return `获取版本信息失败：${error.message}`
      }
    })

  // 存储上次检查的版本信息
  let lastSnapshot = ''
  let lastRelease = ''

  // 检查新版本
  async function checkNewVersion() {
    try {
      const response = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json')
      const { versions } = response.data

      const latest = versions[0]
      const latestRelease = versions.find(v => v.type === 'release')

      // 检查是否有新版本
      if (lastSnapshot && latest.id !== lastSnapshot) {
        const message = `Minecraft 新快照版本发布：${latest.id}\n发布时间：${new Date(latest.releaseTime).toLocaleString()}`
        config.notifyGroups.forEach(groupId => {
          ctx.bots.forEach(bot => bot.sendMessage(groupId, message))
        })
      }

      if (lastRelease && latestRelease.id !== lastRelease) {
        const message = `Minecraft 新正式版本发布：${latestRelease.id}\n发布时间：${new Date(latestRelease.releaseTime).toLocaleString()}`
        config.notifyGroups.forEach(groupId => {
          ctx.bots.forEach(bot => bot.sendMessage(groupId, message))
        })
      }

      // 更新版本记录
      lastSnapshot = latest.id
      lastRelease = latestRelease.id

    } catch (error) {
      ctx.logger('mc-tools').warn('版本检查失败：', error)
    }
  }

  // 启动版本检查
  if (config.enableVersionNotify && config.notifyGroups.length > 0) {
    // 启动时检查一次
    checkNewVersion()
    // 设置定时检查
    setInterval(checkNewVersion, config.checkInterval)
  }

  // 添加 MCPinger 类
  class MCPinger {
        public instance: net.Socket | null = null;

        // 定义常量
        private static readonly HANDSHAKE_PACKET_ID = 0x00;
        private static readonly STATUS_REQUEST_PACKET_ID = 0x00;
        private static readonly NEXT_STATE_STATUS = 1;
        private static readonly DEFAULT_PROTOCOL_VERSION = 765; // Minecraft 1.20.1

        constructor() { }

        /**
         * 编码 VarInt 为 Buffer
         * @param value - 要编码的整数值
         * @returns 编码后的 Buffer
         */
        private encodeVarInt(value: number): Buffer {
            const bytes: number[] = [];
            while (true) {
                if ((value & ~0x7F) === 0) {
                    bytes.push(value);
                    break;
                } else {
                    bytes.push((value & 0x7F) | 0x80);
                    value >>>= 7;
                }
            }
            return Buffer.from(bytes);
        }

        /**
         * 将字符串编码为带有前置长度的 Buffer
         * @param value - 要编码的字符串
         * @returns 编码后的 Buffer
         */
        private writeString(value: string): Buffer {
            const stringBuffer = Buffer.from(value, 'utf8');
            return Buffer.concat([this.encodeVarInt(stringBuffer.length), stringBuffer]);
        }

        /**
         * 解析服务器响应数据
         * @param data - 来自服务器的原始数据 Buffer
         * @returns 解析后的 JSON 对象
         */
        private parseServerResponse(data: Buffer): any {
            const startIndex = data.indexOf('{');
            if (startIndex === -1) {
                throw new Error('无法找到有效的 JSON 开始位置');
            }

            const jsonString = data.slice(startIndex).toString('utf8');
            try {
                return JSON.parse(jsonString);
            } catch (error) {
                throw new Error(`JSON 解析错误: ${error}`);
            }
        }

        /**
         * 解码 VarInt
         * @param buffer - 包含 VarInt 数据的 Buffer
         * @returns 一个元组 [解码后的值, 消耗的字节数]
         */
        private decodeVarInt(buffer: Buffer): [number, number] {
            let value = 0;
            let length = 0;
            let currentByte: number;

            while (true) {
                currentByte = buffer[length];
                value |= (currentByte & 0x7F) << (length * 7);
                length++;

                if ((currentByte & 0x80) === 0) {
                    break;
                }

                if (length > 5) {
                    throw new Error("VarInt is too big");
                }
            }

            return [value, length];
        }

        /**
         * 去除字符串中的 Minecraft 颜色代码
         * @param text - 原始字符串
         * @returns 清理后的字符串
         */
        private cleanMinecraftText(text: string): string {
            return text.replace(/§[0-9a-fk-or]/g, '');
        }

        /**
         * 生成输出字符串
         * @param data - 服务器返回的玩家数据
         * @returns 格式化后的字符串
         */
        private generateOutput(data: { max: number, online: number, sample: { name: string, id: string }[] }): string {
            let result = `(${data.online}/${data.max})`;
            if (data.online !== 0 && data.sample) {
                result += `\n`;
                data.sample.forEach((player, index) => {
                    const cleanName = this.cleanMinecraftText(player.name);
                    result += `${index + 1}. ${cleanName}\n`;
                });
            }
            return result;
        }

        /**
         * 构造握手数据包
         * @param IP - 服务器 IP 地址
         * @param Port - 服务器端口号
         * @param Version - 协议版本
         * @returns 握手数据包
         */
        private createHandshakePacket(IP: string, Port: number, Version: number): Buffer {
            const packetId = this.encodeVarInt(MCPinger.HANDSHAKE_PACKET_ID);
            const protocolVersion = this.encodeVarInt(Version);
            const serverAddress = this.writeString(IP);
            const serverPort = Buffer.alloc(2);
            serverPort.writeUInt16BE(Port);
            const nextState = this.encodeVarInt(MCPinger.NEXT_STATE_STATUS);

            return Buffer.concat([packetId, protocolVersion, serverAddress, serverPort, nextState]);
        }

        /**
         * 构造状态请求数据包
         * @returns 状态请求数据包
         */
        private createStatusRequestPacket(): Buffer {
            return Buffer.concat([this.encodeVarInt(1), this.encodeVarInt(MCPinger.STATUS_REQUEST_PACKET_ID)]);
        }

        /**
         * 将 Minecraft MOTD 从 JSON 格式转换为纯文本，并去除颜色代码和格式化符号
         * @param motd - MOTD 数据（可以是字符串或 JSON 对象）
         * @returns 清理后的纯文本
         */
        private parseMOTD(motd: string | any): string {
            // 如果 MOTD 是 JSON 对象，提取 text 字段
            if (typeof motd === 'object' && motd !== null) {
                if (motd.text) {
                    motd = motd.text;
                } else {
                    motd = '';
                }
            }

            // 如果 MOTD 是字符串，去除颜色代码和格式化符号
            if (typeof motd === 'string') {
                return motd.replace(/§[0-9a-fk-or]/g, '');
            }

            // 如果 MOTD 是其他类型，返回空字符串
            return '';
        }

        /**
         * Ping 一个 Minecraft 服务器以获取其状态信息
         * @param IP - 服务器 IP 地址
         * @param Port - 服务器端口号
         * @param Version - 协议版本（默认 765，表示 Minecraft 1.20.1）
         * @returns 包含服务器信息的字符串
         */
        public async Ping(IP: string, Port: number, Version: number = MCPinger.DEFAULT_PROTOCOL_VERSION): Promise<string> {
            return new Promise((resolve, reject) => {
                this.instance = net.createConnection({ host: IP, port: Port }, () => {
                    try {
                        // 发送握手数据包
                        const handshakePacket = this.createHandshakePacket(IP, Port, Version);
                        const packetLength = this.encodeVarInt(handshakePacket.length);
                        const fullHandshakePacket = Buffer.concat([packetLength, handshakePacket]);
                        this.instance?.write(fullHandshakePacket);

                        // 发送状态请求数据包
                        const statusRequestPacket = this.createStatusRequestPacket();
                        this.instance?.write(statusRequestPacket);
                    } catch (error) {
                        reject(`数据包构造或发送失败: ${error}`);
                    }
                });

                let buffer = Buffer.alloc(0);
                let expectedLength: number | null = null;

                // 处理服务器的响应
                this.instance.on('data', (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);

                    if (expectedLength === null && buffer.length >= 5) {
                        const [packetLength, bytesRead] = this.decodeVarInt(buffer);
                        expectedLength = packetLength + bytesRead;
                    }

                    if (expectedLength !== null && buffer.length >= expectedLength) {
                        const completeData = buffer.slice(0, expectedLength);
                        buffer = buffer.slice(expectedLength);

                        try {
                            const parsedData = this.parseServerResponse(completeData);
                            const autoJsonResult = this.parseMOTD(parsedData.description);
                            const result = `${this.generateOutput(parsedData.players)}Motd: ${autoJsonResult}\n地址: ${IP}:${Port}`;
                            this.instance?.end();
                            resolve(result);
                        } catch (error) {
                            reject(`解析服务器响应失败: ${error}`);
                        }
                    }
                });

                // 处理连接错误
                this.instance.on('error', (err) => {
                    reject(`连接出错: ${err}`);
                });
            });
        }
    }

  ctx.command('mcinfo [server]', '查询MC服务器状态')
    .action(async ({ session }, server) => {
      try {
        let host: string
        let port: number

        if (server?.includes(':')) {
          // 解析 ip:port 格式
          const [inputHost, inputPort] = server.split(':')
          host = inputHost
          port = parseInt(inputPort)

          if (!host || isNaN(port)) {
            return '无效的服务器地址格式，请使用 ip:port 格式或服务器名称'
          }
        } else if (server && config.defaultServers.length > 0) {
          // 查找配置的服务器
          const serverConfig = config.defaultServers.find(s => s.name === server)
          if (!serverConfig) {
            return '未找到指定的服务器配置'
          }
          host = serverConfig.host
          port = serverConfig.port
        } else if (config.defaultServers.length > 0) {
          // 没有指定服务器时，列出所有配置的服务器状态
          const pinger = new MCPinger()
          const results = await Promise.all(config.defaultServers.map(async server => {
            try {
              const status = await pinger.Ping(server.host, server.port)
              return `[${server.name}] ${status}`
            } catch (error) {
              return `[${server.name}] 连接失败: ${error.message}`
            }
          }))
          return results.join('\n\n')
        } else {
          return '请输入服务器地址(ip:port)或在配置中添加默认服务器'
        }

        const pinger = new MCPinger()
        const status = await pinger.Ping(host, port)
        return status

      } catch (error) {
        return `查询失败: ${error.message}`
      }
    })
}
