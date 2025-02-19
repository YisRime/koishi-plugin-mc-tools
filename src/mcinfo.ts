import * as net from 'net'

export class MCInfo {
  private async createConnection(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(port, host)
      socket.setTimeout(5000) // 5秒超时

      socket.on('connect', () => resolve(socket))
      socket.on('timeout', () => {
        socket.destroy()
        reject(new Error('连接超时'))
      })
      socket.on('error', (err) => reject(err))
    })
  }

  private writeVarInt(value: number): Buffer {
    const bytes = []
    while (true) {
      if ((value & ~0x7F) === 0) {
        bytes.push(value)
        break
      }
      bytes.push((value & 0x7F) | 0x80)
      value >>>= 7
    }
    return Buffer.from(bytes)
  }

  async queryServer(host: string, port: number): Promise<string> {
    let socket: net.Socket
    try {
      socket = await this.createConnection(host, port)

      // 构建请求数据包
      const hostname = Buffer.from(host)
      const data = Buffer.concat([
        this.writeVarInt(0), // 数据包ID
        this.writeVarInt(47), // 协议版本
        this.writeVarInt(hostname.length),
        hostname,
        Buffer.from([port >> 8, port & 0xFF]), // 端口
        this.writeVarInt(1) // 请求状态
      ])

      const packet = Buffer.concat([
        this.writeVarInt(data.length),
        data
      ])

      // 发送请求
      socket.write(packet)
      socket.write(Buffer.from([0x01, 0x00])) // 请求状态

      // 读取响应
      const response = await new Promise<string>((resolve) => {
        let data = Buffer.alloc(0)
        socket.on('data', chunk => {
          data = Buffer.concat([data, chunk])
          try {
            const json = data.toString().split('\x00\x00')[0].split('\x00')[3]
            if (json) {
              const serverInfo = JSON.parse(json)
              const msg = [
                `服务器信息 [${host}:${port}]`,
                `描述: ${typeof serverInfo.description === 'object' ? serverInfo.description.text : serverInfo.description}`,
                `在线: ${serverInfo.players.online}/${serverInfo.players.max}`,
                `版本: ${serverInfo.version.name}`
              ]
              if (serverInfo.players.sample?.length) {
                msg.push('在线玩家:')
                serverInfo.players.sample.forEach(p => msg.push(`- ${p.name}`))
              }
              resolve(msg.join('\n'))
            }
          } catch (err) {
            // 继续等待更多数据
          }
        })
      })

      return response
    } catch (error) {
      throw new Error(`无法连接到服务器: ${error.message}`)
    } finally {
      if (socket) socket.destroy()
    }
  }
}
