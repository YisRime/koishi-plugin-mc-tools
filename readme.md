# koishi-plugin-mc-tools

[![npm](https://img.shields.io/npm/v/koishi-plugin-mc-tools?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mc-tools)

我的世界(Minecraft)。可查询 MC 版本、服务器信息、玩家皮肤信息以及四大平台资源；支持管理服务器，功能梭哈

## 功能概述

- **资源查询**：查询MCWiki、MCMOD百科、CurseForge和Modrinth上的内容
- **玩家信息**：查询玩家UUID、皮肤、渲染3D模型和头像
- **版本功能**：查询最新版本，自动推送Minecraft版本更新通知
- **服务器信息**：查询Java版和基岩版服务器状态、玩家、模组和插件列表
- **服务器交互**：通过WebSocket连接服务器、执行RCON命令、发送游戏内消息
- **通知功能**：接收游戏内玩家加入、退出、聊天等事件并推送到群组

## 命令列表

### 基础命令

- `mc.ver` - 查询Minecraft最新版本
- `mc.player <username>` - 查询玩家信息
  - `mc.player.skin <username>` - 获取玩家皮肤预览
  - `mc.player.head <username>` - 获取玩家大头娃娃
  - `mc.player.raw <username>` - 获取玩家原始皮肤
- `mc.info [server]` - 查询Java版服务器信息
  - `mc.info.be [server]` - 查询基岩版服务器信息

### 服务器交互

- `mc.server.say <message>` - 发送聊天消息到服务器
- `mc.server.run <command>` - 执行服务器命令
- `mc.server.broadcast <message>` - 发送全服广播
- `mc.server.tell <player> <message>` - 发送私聊给玩家
- `mc.server.title <title> [subtitle]` - 发送屏幕标题
- `mc.server.actionbar <message>` - 发送动作栏消息
- `mc.server.json <jsonText>` - 发送自定义JSON消息

### 资源查询

- `mc.search <keyword>` - 聚合搜索
- `mc.mcwiki <keyword>` - 查询 MCWiki 内容
- `mc.mcmod <keyword>` - 查询 MCMOD 百科
- `mc.modrinth <keyword>` - 查询 Modrinth 资源
- `mc.curseforge <keyword>` - 查询 CurseForge 资源

## 配置说明

### 基础配置

- **查询开关配置**：启用/禁用各种查询功能
- **资源查询配置**：设置搜索结果显示方式和数量
- **版本&玩家查询配置**：配置版本更新检查和通知目标
- **服务器查询配置**：设置服务器查询API和信息模板

### 服务器连接配置

- **服务器映射群组**：设置群组与服务器的关联
- **RCON配置**：配置RCON连接参数
- **WebSocket配置**：设置WebSocket连接参数

## 信息模板变量

服务器信息模板支持以下变量：

- `{name}` - 服务器地址和端口
- `{ip}` - 服务器IP地址
- `{srv}` - SRV记录信息
- `{icon}` - 服务器图标
- `{motd}` - 服务器描述信息
- `{version}` - 服务器版本
- `{online}` - 在线玩家数
- `{max}` - 最大玩家数
- `{ping}` - 延迟时间
- `{software}` - 服务器软件
- `{edition}` - 服务器版本类型(Java/基岩/教育版)
- `{gamemode}` - 游戏模式
- `{eulablock}` - EULA封禁状态
- `{serverid}` - 服务器ID
- `{playerlist:n}` - 在线玩家列表(限制显示n个)
- `{playercount}` - 在线玩家总数
- `{pluginlist:n}` - 插件列表(限制显示n个)
- `{plugincount}` - 插件总数
- `{modlist:n}` - 模组列表(限制显示n个)
- `{modcount}` - 模组总数

## 文本格式化

支持在发送消息时使用以下格式:

- `color:颜色名` 或 `c:颜色名` - 设置颜色
- `font:字体` 或 `f:字体` - 设置字体
- `bold` 或 `b` - 粗体
- `italic` 或 `i` - 斜体
- `underlined` 或 `u` - 下划线
- `strikethrough` 或 `s` - 删除线
- `obfuscated` 或 `o` - 随机字符
- `click:action=值` - 点击事件(url/run/suggest/copy)
- `hover:action=值` - 悬浮事件(text/item/entity)
- `insert:文本` - 点击插入文本
- `time:淡入,停留,淡出` - 设置标题显示时间

## 注意事项

本插件的截图与皮肤渲染功能依赖 Puppeteer 服务。
以下问题仅出现在 Docker 部署环境：

1. **渲染问题**
   - 症状：皮肤渲染失败或仅显示背景
   - 原因：koishijs/koishi 镜像中的 Chromium 不支持 WebGL
   - 解决：需要替换为 chromium-swiftshader

2. **字体问题**
   - 症状：截图中文字显示不全或变成方块
   - 原因：容器缺少所需字体
   - 解决：需要安装必要的字体包

### 解决方案

```bash
# 删除原有 Chromium（latest-lite 镜像用户跳过此步）
docker exec -it <容器ID> apk del chromium

# 配置国内镜像源（可选）
docker exec -it <容器ID> sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories

# 安装 chromium-swiftshader
docker exec -it <容器ID> apk update
docker exec -it <容器ID> apk add chromium-swiftshader

# 安装基础字体
docker exec -it <容器ID> apk add ttf-dejavu fontconfig

# 安装中文字体
docker exec -it <容器ID> wget https://noto-website-2.storage.googleapis.com/pkgs/NotoSansCJKsc-hinted.zip -P /tmp
docker exec -it <容器ID> unzip /tmp/NotoSansCJKsc-hinted.zip -d /usr/share/fonts/NotoSansCJK
docker exec -it <容器ID> fc-cache -fv
```

完成上述步骤后重启 Puppeteer 插件即可正常使用，无需添加 `--disable-gpu` 参数
