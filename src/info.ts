import { h } from 'koishi'
import { MinecraftToolsConfig, TypeMap } from './index'

interface ParsedServer {
  host: string
  port: number
}
interface BedrockServerInfo {
  edition: string
  motd: string
  protocol: string
  version: string
  online: number
  max: number
}

/**
 * 解析 Minecraft 服务器地址和端口
 * @param {string | undefined} serverAddress - 服务器地址字符串，格式为 "host:port" 或 "host"
 * @param {MinecraftToolsConfig['info']} defaultConfig - 默认服务器配置
 * @returns {ParsedServer} 解析后的服务器信息对象
 * @throws {Error} 当地址格式无效或端口号不合法时抛出错误
 * @private
 */
function parseServer(serverAddress: string | undefined, defaultConfig: MinecraftToolsConfig['info']): ParsedServer {
  const address = serverAddress || defaultConfig.default
  const [host, portStr] = address.split(':')
  if (!host) throw new Error('请输入有效的服务器地址')

  let port = 25565
  if (portStr) {
    const parsedPort = parseInt(portStr)
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('端口号必须在1-65535之间')
    }
    port = parsedPort
  }

  return { host, port }
}

/**
 * 格式化错误消息
 * @param {any} error - 错误对象
 * @returns {string} 格式化后的错误消息
 */
export function formatErrorMessage(error: any): string {
  const errorMessage = error?.message || String(error)

  if (error?.code && TypeMap.errorPatterns[error.code]) {
    return TypeMap.errorPatterns[error.code]
  }

  for (const [pattern, message] of Object.entries(TypeMap.errorPatterns)) {
    if (new RegExp(pattern, 'i').test(errorMessage)) {
      return message
    }
  }

  return `无法连接到服务器：${errorMessage}`
}

/**
 * 创建 Varint 编码的 Buffer
 * @param {number} value - 要编码的数值
 * @returns {Buffer} 编码后的 Buffer
 * @private
 */
function writeVarInt(value: number): Buffer {
  const bytes = []
  do {
    let temp = value & 0b01111111
    value >>>= 7
    if (value !== 0) {
      temp |= 0b10000000
    }
    bytes.push(temp)
  } while (value !== 0)
  return Buffer.from(bytes)
}

/**
 * 查询Java版服务器状态
 * @param {string} host - 服务器主机地址
 * @param {number} port - 服务器端口
 * @returns {Promise<Object>} 服务器状态信息
 * @private
 */
async function queryJavaServer(host: string, port: number): Promise<{
  motd: string
  version: string
  online: number
  max: number
  playerList?: string[]
  favicon?: string
  ping: number
}> {
  const startTime = Date.now()

  return new Promise((resolve, reject) => {
    const net = require('net')
    const socket = new net.Socket()
    let buffer = Buffer.alloc(0)

    socket.setTimeout(5000)

    socket.on('error', (err) => {
      socket.destroy()
      reject(err)
    })

    socket.on('timeout', () => {
      socket.destroy()
      const err = new Error('请求超时')
      err['code'] = 'ETIMEDOUT'
      reject(err)
    })

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      try {
        const response = JSON.parse(buffer.toString('utf8').split('\x00\x00')[1])
        socket.destroy()

        const parseMOTD = (motd: any): string => {
          if (!motd) return ''
          if (typeof motd === 'string') return motd.replace(/§[0-9a-fk-or]/gi, '')
          if (typeof motd !== 'object') return String(motd)

          let result = ''
          if ('text' in motd) result += motd.text
          if ('extra' in motd && Array.isArray(motd.extra)) {
            result += motd.extra.map(parseMOTD).join('')
          }
          if (Array.isArray(motd)) {
            result += motd.map(parseMOTD).join('')
          }
          return result.replace(/§[0-9a-fk-or]/gi, '')
        }

        resolve({
          motd: parseMOTD(response.description),
          version: response.version?.name || '未知版本',
          online: response.players?.online ?? 0,
          max: response.players?.max ?? 0,
          playerList: response.players?.sample?.map(p => p.name),
          favicon: response.favicon,
          ping: Date.now() - startTime
        })
      } catch (err) {
        // 如果解析失败，继续等待更多数据
      }
    })

    socket.connect(port, host, () => {
      // 发送握手包和状态请求包
      const hostBuffer = Buffer.from(host, 'utf8')
      const handshakePacket = Buffer.concat([
        writeVarInt(0), // Packet ID
        writeVarInt(47), // Protocol Version
        writeVarInt(hostBuffer.length),
        hostBuffer,
        Buffer.from([port >> 8, port & 255]), // Port
        writeVarInt(1), // Next State (1 for Status)
      ])

      const handshake = Buffer.concat([
        writeVarInt(handshakePacket.length),
        handshakePacket
      ])

      const statusRequest = Buffer.from([0x01, 0x00])

      socket.write(handshake)
      socket.write(statusRequest)
    })
  })
}

/**
 * 查询基岩版服务器状态
 * @param {string} host - 服务器主机地址
 * @param {number} port - 服务器端口
 * @returns {Promise<Object>} 服务器状态信息
 * @private
 */
async function queryBedrockServer(host: string, port: number): Promise<{
  motd: string
  version: string
  online: number
  max: number
  ping: number
}> {
  const startTime = Date.now()
  const result = await new Promise<BedrockServerInfo>((resolve, reject) => {
    const dgram = require('dgram')
    const client = dgram.createSocket('udp4')

    const timeout = setTimeout(() => {
      client.close()
      const error = new Error('请求超时')
      error['code'] = 'ETIMEDOUT'
      reject(error)
    }, 5000)

    const query = Buffer.from([
      0x01,
      0x00,
      ...Buffer.from([Math.floor(Date.now() / 1000)].map(n => [
        (n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF
      ]).flat()),
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ])

    client.on('message', (msg) => {
      clearTimeout(timeout)
      client.close()

      try {
        const data = msg.toString('utf8', 35).split(';')
        if (data.length < 6) {
          const error = new Error('无效的服务器响应')
          error['code'] = 'invalid server response'
          throw error
        }

        resolve({
          edition: data[0],
          motd: data[1],
          protocol: data[2],
          version: data[3],
          online: parseInt(data[4]),
          max: parseInt(data[5])
        })
      } catch (error) {
        reject(error)
      }
    })

    client.on('error', (err: any) => {
      clearTimeout(timeout)
      client.close()
      reject(err)
    })

    client.send(query, port, host)
  })

  return {
    motd: result.motd,
    version: `${result.version}`,
    online: result.online,
    max: result.max,
    ping: Date.now() - startTime
  }
}

/**
 * 检查服务器状态
 */
export async function checkServerStatus(server: string | undefined, config: MinecraftToolsConfig) {
  const { host, port } = parseServer(server, config.info)

  const isDefaultJava = port === 25565
  const isDefaultBedrock = port === 19132

  try {
    let result
    if (isDefaultBedrock) {
      result = await queryBedrockServer(host, port)
    } else if (isDefaultJava) {
      result = await queryJavaServer(host, port)
    } else {
      const results = await Promise.race([
        queryJavaServer(host, port).catch(e => ({ error: e, type: 'java' })),
        queryBedrockServer(host, port).catch(e => ({ error: e, type: 'bedrock' }))
      ])

      if ('error' in results) {
        throw results.error
      }
      result = results
    }

    const lines: string[] = []

    if (config.info.showIcon && 'favicon' in result && result.favicon?.startsWith('data:image/png;base64,')) {
      lines.push(h.image(result.favicon).toString())
    }

    if (result.motd) lines.push(result.motd)

    const statusParts = [
      result.version,
      `${result.online}/${result.max}`,
      `${result.ping}ms`
    ]
    lines.push(statusParts.join(' | '))

    if (config.info.showPlayers && result.playerList?.length > 0) {
      const playerInfo = ['当前在线：' + result.playerList.join(', ')]
      if (result.playerList.length < result.online) {
        playerInfo.push(`（仅显示 ${result.playerList.length}/${result.online} 名玩家）`)
      }
      lines.push(playerInfo.join(''))
    }

    const data = lines.join('\n')
    return server ? data : `${host}:${port}\n${data}`

  } catch (error) {
    throw new Error(formatErrorMessage(error))
  }
}
