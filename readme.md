# koishi-plugin-mc-tools

[![npm](https://img.shields.io/npm/v/koishi-plugin-mc-tools?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mc-tools)

基于 Koishi 的 Minecraft 工具箱，支持查阅百科，查询服务器，查询 MC 最新版本和玩家皮肤等功能

## 功能特性

- 查询 Minecraft Wiki 和 MCMOD 百科
- 搜索 Modrinth 和 CurseForge 项目
- 生成 Wiki 和 MCMOD 页面截图
- Minecraft 服务器状态实时查询
- 自动检查并推送 Minecraft 版本更新
- 多语言 Wiki 支持
- 获取玩家信息与 3D 皮肤预览

## 命令列表

### Wiki 相关命令

- `mcwiki <关键词>` - 直接查询 Wiki 页面
- `mcwiki.find <关键词>` - 搜索并选择 Wiki 页面
- `mcwiki.shot <关键词>` - 获取 Wiki 页面截图

### 模组相关命令

- `mod <关键词>` - 直接搜索 MCMOD 页面
- `mod.find <关键词>` - 搜索并选择 MCMOD 页面
- `mod.shot <关键词>` - 获取 MCMOD 页面截图
- `mod.mr <关键词> [类型]` - 获取 Modrinth 项目详情
- `mod.findmr <关键词> [类型]` - 搜索 Modrinth 项目
- `mod.cf <关键词> [类型]` - 获取 CurseForge 项目详情
- `mod.findcf <关键词> [类型]` - 搜索 CurseForge 项目

### 其他功能

- `mcver` - 获取 Minecraft 最新版本信息
- `mcinfo [服务器地址:端口]` - 查询 MC 服务器状态
- `mcskin <用户名>` - 获取玩家信息和3D皮肤预览

## 配置说明

### 通用设置

```yaml
wiki:
  totalLength: 400      # 总预览字数
  descLength: 20       # 搜索项目描述字数
  Timeout: 15         # 搜索超时时间（秒）
```

### 查询设置

```yaml
search:
  Language: 'zh'      # Wiki 显示语言
  sectionLength: 50   # Wiki 每段预览字数
  linkCount: 4       # 相关链接最大显示数
  cfApi: ''         # CurseForge API Key
```

### 服务器设置

```yaml
info:
  default: 'localhost:25565'  # INFO 默认服务器
  showIcon: true             # 显示服务器图标
  showPlayers: true          # 显示在线玩家列表
```

### 更新检测设置

```yaml
ver:
  enabled: false        # 启用版本更新检查
  release: true        # 通知正式版本
  snapshot: true       # 通知快照版本
  interval: 60         # 检查间隔时间（分钟）
  groups: []          # 接收更新通知 ID
```

## 注意事项

截图与渲染皮肤依赖 Puppeteer 服务，请先安装带有 Puppeteer 服务的插件。
若渲染皮肤出错或渲染出的图片仅有背景，请使用 chromium-swiftshader。
因为 koishijs/koishi 镜像中的 Chromium 并不支持 WebGL。

### 解决方案

```bash
# 删除原有 Chromium （如果使用 latest-lite 镜像请忽略）
docker exec -it <容器ID> apk del chromium
# 更换镜像源（如果可以访问 Docker Hub 请忽略）
docker exec -it <容器ID> sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
# 安装 chromium-swiftshader
docker exec -it <容器ID> apk update
docker exec -it <容器ID> apk add chromium-swiftshader
```

之后重启 Puppeteer 插件即可
