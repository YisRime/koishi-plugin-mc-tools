import { Session } from 'koishi'
import { Rcon } from 'rcon-client'
import { MinecraftToolsConfig } from './index'

// 全局WebSocket连接引用（从index.ts中导入）
declare const wsConnection: WebSocket | null

/**
 * 自动撤回消息
 */
export async function autoRecall(message: string, session?: Session): Promise<void> {
  if (!session) return

  const msgId = await session.send(message)
  if (!msgId) return

  setTimeout(() => {
    try {
      const ids = Array.isArray(msgId) ? msgId : [msgId]
      ids.forEach(id => session.bot?.deleteMessage(session.channelId, String(id)))
    } catch {}
  }, 10000)
}

/**
 * 执行RCON命令
 */
export async function executeRconCommand(
  command: string,
  config: MinecraftToolsConfig,
  session?: Session
): Promise<void> {
  if (!command) return autoRecall('请输入要执行的命令', session)
  if (!config.link.rconPassword) return autoRecall('请先配置RCON密码', session)

  const [serverHost, portStr] = (config.link.rconAddress || '').split(':')
  const port = portStr ? parseInt(portStr) : 25575

  if (!serverHost) return autoRecall('请先配置RCON地址', session)
  if (isNaN(port)) return autoRecall('RCON端口不正确', session)

  try {
    const rcon = await Rcon.connect({
      host: serverHost, port, password: config.link.rconPassword
    })

    const result = await rcon.send(command)
    await rcon.end()

    return autoRecall(`命令执行成功${result}`, session)
  } catch (error) {
    const errorMsg = `RCON连接失败: ${error.message}`
    return autoRecall(errorMsg, session)
  }
}

/**
 * 检查群组是否有权限
 */
export function checkGroupPermission(session, group: string): boolean {
  if (!group || !session) return false

  // 创建授权格式 "平台:群组ID"
  const sessionGroup = `${session.platform}:${session.guildId}`
  return sessionGroup === group
}

/**
 * 发送WebSocket消息到Minecraft服务器
 */
export async function sendWebSocketMessage(
  api: string,
  data: any,
  session?: Session
): Promise<boolean> {
  if (!wsConnection) {
    await autoRecall('WebSocket未连接', session)
    return false
  }

  try {
    const message = {
      api,
      data,
      echo: Date.now().toString()
    }

    wsConnection.send(JSON.stringify(message))
    return true
  } catch (error) {
    await autoRecall(`发送WebSocket消息失败: ${error.message}`, session)
    return false
  }
}

/**
 * 发送广播消息到Minecraft服务器
 */
export async function broadcastToMinecraft(
  message: string,
  color: string = 'white',
  session?: Session
): Promise<boolean> {
  const messageData = {
    message: {
      type: 'text',
      data: {
        text: message,
        color
      }
    }
  }

  return sendWebSocketMessage('send_msg', messageData, session)
}

/**
 * 发送私聊消息到Minecraft玩家
 */
export async function sendPrivateMessageToPlayer(
  player: string,
  message: string,
  color: string = 'white',
  session?: Session
): Promise<boolean> {
  // 判断player是否为UUID格式
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player)

  const messageData = {
    uuid: isUUID ? player : '',
    nickname: isUUID ? '' : player,
    message: {
      type: 'text',
      data: {
        text: message,
        color
      }
    }
  }

  return sendWebSocketMessage('send_private_msg', messageData, session)
}

/**
 * 发送标题到Minecraft服务器
 */
export async function sendTitleToMinecraft(
  title: string,
  subtitle: string = '',
  fadein: number = 10,
  stay: number = 70,
  fadeout: number = 20,
  session?: Session
): Promise<boolean> {
  const titleData = {
    title: {
      type: 'text',
      data: {
        text: title
      }
    },
    subtitle: subtitle ? {
      type: 'text',
      data: {
        text: subtitle
      }
    } : '',
    fadein,
    stay,
    fadeout
  }

  return sendWebSocketMessage('send_title', titleData, session)
}

/**
 * 发送动作栏消息到Minecraft服务器
 */
export async function sendActionbarToMinecraft(
  message: string,
  color: string = 'white',
  session?: Session
): Promise<boolean> {
  const actionbarData = {
    message: {
      type: 'text',
      data: {
        text: message,
        color
      }
    }
  }

  return sendWebSocketMessage('send_actionbar', actionbarData, session)
}
