import { Context } from 'koishi'
import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * 白名单绑定数据接口
 * @interface WhitelistBindings
 */
export interface WhitelistBindings {
  [userId: string]: {
    [minecraftUsername: string]: number;
  }
}

/**
 * 文件管理器类，用于处理JSON数据的保存和加载
 * @class FileManager
 */
export class FileManager {
  private dataDir: string

  constructor(private ctx: Context) {
    this.dataDir = path.join(ctx.baseDir, 'data')
  }

  /**
   * 保存数据到JSON文件
   * @template T 数据类型
   * @param filename 文件名
   * @param data 数据对象
   * @returns 保存是否成功
   */
  async saveJson<T>(filename: string, data: T): Promise<boolean> {
    try {
      const filePath = path.join(this.dataDir, filename)
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
      return true
    } catch (error) {
      this.ctx.logger.error(`保存文件失败 (${filename}): ${error.message}`)
      return false
    }
  }

  /**
   * 从JSON文件读取数据
   * @template T 数据类型
   * @param filename 文件名
   * @param defaultValue 默认值，当文件不存在或读取失败时返回
   * @returns 读取到的数据或默认值
   */
  async loadJson<T>(filename: string, defaultValue: T): Promise<T> {
    try {
      const filePath = path.join(this.dataDir, filename)
      try {
        const data = await fs.readFile(filePath, 'utf8')
        return JSON.parse(data) as T
      } catch (error) {
        if (error.code === 'ENOENT') {
          await this.saveJson(filename, defaultValue)
          return defaultValue
        }
        throw error
      }
    } catch (error) {
      this.ctx.logger.error(`读取文件失败 (${filename}): ${error.message}`)
      return defaultValue
    }
  }

  /**
   * 获取白名单绑定数据
   * @returns 白名单绑定数据对象，如果不存在则返回空对象
   */
  async getWhitelistBindings(): Promise<WhitelistBindings> {
    return await this.loadJson<WhitelistBindings>('whitelist.json', {})
  }

  /**
   * 保存白名单绑定数据
   * @param bindings 绑定数据
   * @returns 保存是否成功
   */
  async saveWhitelistBindings(bindings: WhitelistBindings): Promise<boolean> {
    return await this.saveJson('whitelist.json', bindings)
  }
}