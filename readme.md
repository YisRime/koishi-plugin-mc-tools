# koishi-plugin-mc-tools

[![npm](https://img.shields.io/npm/v/koishi-plugin-mc-tools?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mc-tools)

Minecraft(我的世界)工具箱插件,提供Wiki查询、版本检查、服务器状态查询等功能。

## 功能

- Wiki查询
  - `mcwiki <关键词>` - 直接查询Wiki内容
  - `mcwiki.search <关键词>` - 搜索并选择Wiki条目
  - `mcwiki.shot <关键词>` - 获取Wiki页面截图

- MCMOD百科查询
  - `modwiki <关键词>` - 直接查询模组信息
  - `modwiki.search <关键词>` - 搜索并选择模组
  - `modwiki.latest` - 查看最新更新的模组

- 版本检查
  - `mcver` - 获取Minecraft最新版本信息
  - 自动检查版本更新并推送通知(可配置)

- 服务器状态
  - `mcinfo [服务器地址]` - 查询MC服务器状态

## 配置项

```yaml
# Wiki相关设置
wiki:
  defaultLanguage: zh    # 默认的Wiki浏览语言
  pageTimeout: 30        # 获取页面超时时间(秒)
  searchResultLimit: 10  # 搜索结果最大显示数量

# 版本更新检查设置
versionCheck:
  enabled: false        # 是否启用版本更新检查
  groups: []           # 接收版本更新通知的群组ID
  interval: 60         # 版本检查间隔时间(分钟)

# 默认的Minecraft服务器配置
server:
  host: localhost      # 默认服务器地址
  port: 25565         # 默认服务器端口
```

## 支持的Wiki语言

- 中文(简体) - zh
- 中文(繁體/香港) - zh-hk
- 中文(繁體/台灣) - zh-tw
- English - en
- 日本語 - ja
- 한국어 - ko
- Français - fr
- Deutsch - de
- Español - es
- Italiano - it
- Português - pt
- Русский - ru
- Polski - pl
- Nederlands - nl
- Türkçe - tr

## 注意事项

1. Wiki截图功能需要安装并配置koishi-plugin-puppeteer插件
2. 服务器状态查询功能支持所有版本的Minecraft服务器
3. 部分功能可能需要良好的网络环境
