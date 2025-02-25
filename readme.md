# koishi-plugin-mc-tools

[![npm](https://img.shields.io/npm/v/koishi-plugin-mc-tools?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mc-tools)

基于 Koishi 框架的 Minecraft 工具箱，提供多功能查询和信息服务。

## 功能特性

- 快速查询 Minecraft Wiki 和 MCMOD 百科
- 支持生成 Wiki 和 MCMOD 页面截图
- Minecraft 服务器状态实时查询
- 自动检查并推送 Minecraft 版本更新
- 支持多语言 Wiki 切换
- 高度可配置的功能选项

## 命令列表

### Wiki 相关命令

- `mcwiki <关键词>` - 直接查询 Wiki 内容
- `mcwiki.search <关键词>` - 搜索并选择 Wiki 条目
- `mcwiki.shot <关键词>` - 获取 Wiki 页面截图

### MCMOD 相关命令

- `modwiki <关键词>` - 直接查询 MCMOD 内容
- `modwiki.search <关键词>` - 搜索并选择 MCMOD 条目
- `modwiki.shot <关键词>` - 获取 MCMOD 页面截图

### 其他功能

- `mcver` - 获取 Minecraft 最新版本信息
- `mcinfo [服务器地址:端口]` - 查询 MC 服务器状态

## 配置说明

### Wiki 设置

```yaml
wiki:
  defaultLanguage: zh    # Wiki 默认显示语言
  minSectionLength: 12   # Wiki 段落最小字数
  sectionPreviewLength: 50    # Wiki 段落预览字数
  totalPreviewLength: 500     # 总预览字数
  showVersions: true     # 是否显示支持版本
  showLinks: true       # 是否显示相关链接
  showDescription: true # 是否显示简介
  imageEnabled: true    # 是否显示图片
  searchTimeout: 10     # 搜索选择时间（秒）
  searchDescLength: 60  # 搜索结果描述字数
```

### 版本检查设置

```yaml
versionCheck:
  enabled: false        # 是否启用版本更新检查
  groups: []           # 接收版本更新通知的群组 ID
  interval: 60         # 检查间隔时间（分钟）
  notifyOnRelease: true    # 是否通知正式版更新
  notifyOnSnapshot: true   # 是否通知快照版更新
```

### 服务器查询设置

```yaml
server:
  address: localhost:25565    # 默认服务器地址
  showIcon: true             # 是否显示服务器图标
  showPlayers: true          # 是否显示在线玩家列表
```
