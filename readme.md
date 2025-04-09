# koishi-plugin-mc-tools

[![npm](https://img.shields.io/npm/v/koishi-plugin-mc-tools?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mc-tools)

我的世界（Minecraft/MC）工具。支持查询MCWiki/MCMod/CurseForge/Modrinth、服务器信息、最新版本和玩家皮肤；推送MC更新通知，运行命令等

## 功能特性

- 多语言 Minecraft Wiki 查询、搜索和页面截图功能
- MCMod 内容的详细查询、搜索和页面截图
- Modrinth 和 CurseForge 模组平台高级搜索与分类查询
- Java 和 Bedrock 服务器状态查询和详细信息获取
- Minecraft 版本更新检测与自动推送通知
- 玩家信息查询与 3D 皮肤和披风渲染预览
- 完整的 RCON 远程命令管理系统
- WebSocket 服务器互联系统，支持聊天消息和事件同步

## 命令列表

### Wiki 相关命令

- `mc.wiki <关键词>` - 查询 Minecraft Wiki
- `mc.wiki.find <关键词>` - 搜索 Wiki 页面
- `mc.wiki.shot <关键词>` - 截图 Wiki 页面

### 模组相关命令

- `mc.mod <关键词>` - 查询 MCMod
- `mc.mod.find <关键词>` - 搜索 MCMod
- `mc.mod.shot <关键词>` - 截图 MCMod 页面
- `mc.mod.mr <关键词> [类型]` - 查询 Modrinth
  - 支持的类型: `mod`(模组), `resourcepack`(资源包), `datapack`(数据包), `shader`(光影), `modpack`(整合包), `plugin`(插件)
- `mc.mod.mr.find <关键词> [类型]` - 搜索 Modrinth
- `mc.mod.cf <关键词> [类型]` - 查询 CurseForge
  - 支持的类型: `mod`(模组), `resourcepack`(资源包), `modpack`(整合包), `shader`(光影), `datapack`(数据包), `world`(地图), `addon`(附加包), `plugin`(插件)
- `mc.mod.cf.find <关键词> [类型]` - 搜索 CurseForge

### 服务器信息查询

- `mc.info [server]` - 查询 Java 版服务器信息
- `mc.info.be [server]` - 查询 Bedrock 版服务器信息
- `mc.ver` - 查询 Minecraft 最新版本信息
- `mc.skin <用户名>` - 查询玩家信息与皮肤
  - `-e` 显示鞘翅
  - `-c` 显示披风
- `mc.skin.head <用户名>` - 获取玩家头像

### 服务器管理命令

- `mc.server.say <message>` - 发送消息到服务器
- `mc.server.run <command>` - 执行自定义命令

WebSocket 连接模式额外支持的命令:

- `mc.server.broadcast <message>` - 以更醒目的方式广播消息
  - `-c <color>` 设置颜色
  - `-b` 使用粗体
  - `-i` 使用斜体
  - `-u` 使用下划线
  - `-s` 使用删除线
  - `-o` 使用混淆效果
  - `-f <font>` 使用自定义字体
  - 更多高级选项: `--url`, `--cmd`, `--suggest`, `--copy`, `--hover`
- `mc.server.tell <player> <message>` - 向指定玩家发送私聊消息 (支持与广播相同的样式选项)
- `mc.server.title <title> [subtitle]` - 发送标题消息
  - `-i <time>` 淡入时间
  - `-s <time>` 停留时间
  - `-o <time>` 淡出时间
  - `-c <color>` 标题颜色
  - `-sc <color>` 副标题颜色
  - `-b` 标题使用粗体
  - 更多样式选项: `--italic`, `-u`, `--sb`, `--si`, `--su`
- `mc.server.actionbar <message>` - 发送动作栏消息 (支持与广播相同的样式选项)
- `mc.server.json <jsonText>` - 发送复杂的JSON格式消息
  - `-t <type>` 消息类型 (chat/broadcast/whisper/title/actionbar)
  - `-p <player>` 玩家名称 (whisper类型使用)

## 配置说明

### 查询配置

```yaml
totalLength: 400      # 内容预览总字数
sectionLength: 50     # Wiki 每段预览字数
descLength: 20        # 搜索结果描述字数限制
linkCount: 4          # MCMod 相关链接显示数量
Timeout: 15           # 搜索与交互超时时间 (秒)
captureTimeout: 3     # 截图超时时间 (秒)
maxHeight: 4096       # 截图最大高度 (像素)
waitUntil: 'domcontentloaded'  # 截图等待条件
Language: 'zh'        # Wiki默认语言
showImages: 'noqq'    # 图片显示策略: always(总是), noqq(非QQ平台), never(禁用)
cfApi: ''             # CurseForge API Key
```

### 工具配置

```yaml
verCheck: false       # 是否启用版本更新检查
release: true         # 是否检查正式版更新
snapshot: true        # 是否检查快照版更新
interval: 5           # 检查间隔 (分钟)
guilds:               # 更新通知目标 (格式: platform:type:id)
  - 'onebot:private:123456789'
  - 'onebot:guild:123456789'
showSkull: true       # 是否显示如何获取玩家头颅信息
showIP: false         # 是否显示服务器IP地址
showIcon: true        # 是否显示服务器图标
maxNumber: 8          # 列表最大显示数量
default: 'hypixel.net'  # 默认服务器地址
javaApis:             # Java版查询API
  - 'https://api.mcstatus.io/v2/status/java/${address}'
  - 'https://api.mcsrvstat.us/3/${address}'
bedrockApis:          # 基岩版查询API
  - 'https://api.mcstatus.io/v2/status/bedrock/${address}'
  - 'https://api.mcsrvstat.us/bedrock/3/${address}'
```

### 服务器互联配置

```yaml
connect: 'onebot:123456789'  # 互联群组ID (platform:channelId)
enableRcon: false            # 是否启用RCON连接
rconAddress: 'localhost:25575'  # RCON地址
rconPassword: ''             # RCON密码
enableWebSocket: false       # 是否启用WebSocket连接
name: 'Server'               # 服务器名称
websocketMode: 'client'      # WebSocket模式: client(客户端) 或 server(服务端)
websocketAddress: 'localhost:8080'  # WebSocket地址或监听地址
websocketToken: ''           # WebSocket认证令牌
```

## WebSocket 服务器互联（鹊桥互联）

本插件支持与 Minecraft 服务器建立 WebSocket 连接，实现聊天消息同步和事件监听。支持两种连接模式:

### 客户端模式

将 Koishi 作为 WebSocket 客户端，连接到 Minecraft 服务器上运行的 WebSocket 服务端。

### 服务端模式

将 Koishi 作为 WebSocket 服务端，让 Minecraft 服务器作为客户端连接。
适用于无法直接访问 Minecraft 服务器网络的情况。

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
