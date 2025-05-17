import { Context, Session } from 'koishi'
import { renderOutput } from './render'

/**
 * API基础URL
 */
const CF_API_BASE = 'https://api.curseforge.com/v1'
const MR_API_BASE = 'https://api.modrinth.com/v2'

/**
 * 搜索选项接口
 * @interface SearchOptions
 */
interface SearchOptions {
  version?: string;
  loader?: string;
  [key: string]: any;
}

/**
 * API请求函数
 * @param {Context} ctx - Koishi上下文
 * @param {string} url - API请求URL
 * @param {object} options - 请求选项
 * @returns {Promise<any>} 请求结果
 */
async function fetchAPI(ctx: Context, url: string, options = {}) {
  try {
    return await ctx.http.get(url, options);
  } catch (error) {
    ctx.logger.error(`API请求失败: ${url}`, error);
    return null;
  }
}

/**
 * 获取Modrinth项目版本列表
 * @param {Context} ctx - Koishi上下文
 * @param {string} projectId - Modrinth项目ID
 * @param {SearchOptions} options - 搜索选项
 * @returns {Promise<any[]>} 版本列表
 */
async function getModrinthVersions(ctx: Context, projectId: string, options: SearchOptions = {}) {
  const result = await fetchAPI(ctx, `${MR_API_BASE}/project/${projectId}/version`);
  if (!result) return [];
  return [...result]
    .sort((a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime())
    .filter(v => !options.version || v.game_versions?.includes(options.version))
    .filter(v => !options.loader || v.loaders?.includes(options.loader));
}

/**
 * 获取CurseForge模组文件列表
 * @param {Context} ctx - Koishi上下文
 * @param {number} modId - CurseForge模组ID
 * @param {string} apiKey - CurseForge API密钥
 * @param {SearchOptions} options - 搜索选项
 * @param {number} index - 分页起始索引
 * @param {number} pageSize - 每页大小
 * @returns {Promise<{files: any[], pagination: any}>} 文件列表和分页信息
 */
async function getCurseForgeFiles(ctx: Context, modId: number, apiKey: string, options: SearchOptions = {}, index: number = 0, pageSize: number = 50) {
  const params: any = { index };
  if (options.version) params.gameVersion = options.version;
  if (options.loader && options.loader in {forge: 1, fabric: 1, quilt: 1}) params.modLoaderType = options.loader === 'forge' ? 1 : options.loader === 'fabric' ? 4 : 5;
  const response = await fetchAPI(ctx, `${CF_API_BASE}/mods/${modId}/files`, { headers: { 'x-api-key': apiKey }, params });
  return { files: response?.data || [], pagination: response?.pagination || { index, pageSize, resultCount: 0, totalCount: 0 } };
}

/**
 * 格式化文件大小
 * @param {number} bytes - 文件字节大小
 * @returns {string} 格式化后的文件大小字符串
 */
function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes, unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(unitIndex > 0 ? 2 : 0)} ${units[unitIndex]}`;
}

/**
 * 处理用户输入
 * @param {Session} session - Koishi会话
 * @param {string} input - 用户输入
 * @param {any[]} pageFiles - 当前页的文件列表
 * @param {boolean} isLastPage - 是否为最后一页
 * @param {number} startIndex - 当前页起始索引
 * @returns {Promise<{action: 'select'|'next'|'cancel', index?: number}>} 用户操作结果
 */
async function handleUserInput(session: Session, input: string, pageFiles: any[], isLastPage: boolean, startIndex: number): Promise<{action: 'select'|'next'|'cancel', index?: number}> {
  if (!input || input.toLowerCase() === 'c') return { action: 'cancel' };
  if (input.toLowerCase() === 'n') return isLastPage ? { action: 'cancel' } : { action: 'next' };
  const index = parseInt(input) - 1;
  // 检查输入的序号是否在当前页的范围内
  const pageIndex = index - startIndex;
  if (isNaN(index) || pageIndex < 0 || pageIndex >= pageFiles.length) {
    await session.send(`请回复序号下载文件，输入n查看下页，输入c取消`);
    return handleUserInput(session, await session.prompt(60000), pageFiles, isLastPage, startIndex);
  }
  return { action: 'select', index: pageIndex };
}

/**
 * 格式化文件展示信息
 * @param {any} file - 文件信息
 * @param {string} platform - 平台名称 ('modrinth' 或 'curseforge')
 * @param {number} globalIndex - 全局索引
 * @returns {string} 格式化的文件信息字符串
 */
function formatFileInfo(file: any, platform: string, globalIndex: number): string {
  const index = globalIndex + 1;
  if (platform === 'modrinth') {
    return `${index}. ${file.name} [${file.game_versions?.join(', ')}] [${file.loaders?.join(', ')}] (${formatFileSize(file.files[0].size)})`;
  } else {
    const loaders = (file.gameVersions || []).filter(v => !(/^\d+\.\d+(\.\d+)?$/.test(v)) && v !== "Client").join(", ");
    const versions = (file.gameVersions || []).filter(v => /^\d+\.\d+(\.\d+)?$/.test(v)).join(", ");
    return `${index}. ${file.displayName || file.fileName} [${versions}] [${loaders}] (${formatFileSize(file.fileLength)})`;
  }
}

/**
 * 显示文件列表
 * @param {Session} session - Koishi会话
 * @param {any[]} files - 文件列表
 * @param {string} pageInfo - 页面信息
 * @param {string} platform - 平台名称
 * @param {Context} ctx - Koishi上下文
 * @param {any} config - 配置信息
 * @param {number} startIndex - 当前页起始索引
 * @returns {Promise<void>}
 */
async function displayFileList(session: Session, files: any[], pageInfo: string, platform: string, ctx: Context, config: any, startIndex: number): Promise<void> {
  const messages = [
    '请回复序号下载文件，输入n查看下页，输入c取消',
    ...files.map((file, i) => formatFileInfo(file, platform, startIndex + i)), pageInfo
  ];
  await renderOutput(session, messages, null, ctx, config, false);
}

/**
 * 处理模组下载流程
 * @param {Context} ctx - Koishi上下文
 * @param {Session} session - Koishi会话
 * @param {string} platform - 平台名称 ('modrinth' 或 'curseforge')
 * @param {any} project - 项目信息
 * @param {any} config - 配置信息
 * @param {SearchOptions} options - 搜索选项
 * @returns {Promise<string>} 处理结果信息
 */
export async function handleDownload(ctx: Context, session: Session, platform: string, project: any, config: any, options: SearchOptions = {}) {
  try {
    let allFiles = [], currentIndex = 0, currentPage = 0, totalItems = 0;
    let hasMoreResults = true;
    const displayPageSize = config.searchResults || 10;
    let cfPagination = null;
    // 获取初始数据
    if (platform === 'modrinth') {
      allFiles = await getModrinthVersions(ctx, project.project_id, options);
      totalItems = allFiles.length; hasMoreResults = false;
      if (!allFiles?.length) return '该项目未找到任何版本';
    }
    while (true) {
      // 按需加载CurseForge数据
      if (platform === 'curseforge' && (currentPage * displayPageSize >= allFiles.length) && hasMoreResults) {
        const result = await getCurseForgeFiles(ctx, project.id, config.curseforgeEnabled, options, currentIndex);
        if (!result.files?.length) {
          if (allFiles.length === 0) return '该项目未找到任何文件';
          hasMoreResults = false;
        } else {
          allFiles = [...allFiles, ...result.files];
          currentIndex += result.pagination.pageSize;
          cfPagination = result.pagination;
          totalItems = cfPagination.totalCount;
          hasMoreResults = allFiles.length < cfPagination.totalCount;
        }
      }
      // 计算当前页内容
      const startIndex = currentPage * displayPageSize;
      if (startIndex >= allFiles.length) return '已取消下载';
      const endIndex = Math.min(startIndex + displayPageSize, allFiles.length);
      const pageFiles = allFiles.slice(startIndex, endIndex);
      const totalPages = Math.ceil(totalItems / displayPageSize);
      const isLastPage = !hasMoreResults && (endIndex >= allFiles.length);
      const pageInfo = `第 ${currentPage + 1}/${totalPages || '?'} 页${isLastPage ? '（最后一页）' : ''}`;
      await displayFileList(session, pageFiles, pageInfo, platform, ctx, config, startIndex);
      const input = await session.prompt(60000);
      const result = await handleUserInput(session, input, pageFiles, isLastPage, startIndex);
      if (result.action === 'cancel') {
        return '已取消下载';
      } else if (result.action === 'next') {
        if (!isLastPage) currentPage++;
        else return '已取消下载';
      } else if (result.action === 'select' && result.index !== undefined) {
        const selectedFile = pageFiles[result.index];
        if (platform === 'modrinth') {
          // Modrinth文件下载
          if (selectedFile.files.length > 1) {
            const fileMessages = [
              '请选择要下载的文件：',
              ...selectedFile.files.map((f, i) => `${i + 1}. ${f.filename} (${formatFileSize(f.size)}) [${f.primary ? '主要' : '次要'}]`)
            ];
            await renderOutput(session, fileMessages, null, ctx, config, false);
            const fileInput = await session.prompt(60000);
            const fileIndex = parseInt(fileInput) - 1;
            if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= selectedFile.files.length) return '无效选择';
            await session.send(`[${selectedFile.files[fileIndex].filename}](${selectedFile.files[fileIndex].url})`);
          } else {
            await session.send(`[${selectedFile.files[0].filename}](${selectedFile.files[0].url})`);
          }
        } else {
          // CurseForge文件下载
          if (!selectedFile.downloadUrl) return '获取下载链接失败';
          await session.send(`[${selectedFile.fileName}](${selectedFile.downloadUrl})`);
        }
        return '';
      }
    }
  } catch (error) {
    ctx.logger.error(`下载处理失败:`, error);
    return '下载过程中出错';
  }
}