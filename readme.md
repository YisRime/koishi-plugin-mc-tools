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
- 完整的 RCON 远程命令管理系统（消息广播、白名单管理、管理员操作等）

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
- `mc.mod.mr.find <关键词> [类型]` - 搜索 Modrinth
- `mc.mod.cf <关键词> [类型]` - 查询 CurseForge
- `mc.mod.cf.find <关键词> [类型]` - 搜索 CurseForge

### 服务器信息查询

- `mc.info [server]` - 查询 Java 版服务器信息
- `mc.info.be [server]` - 查询 Bedrock 版服务器信息

### 服务器管理命令

- `mc.server` - 查看 Minecraft 服务器状态
- `mc.server.say <message>` - 发送消息到服务器
- `mc.server.tell <player> <message>` - 向指定玩家发送私聊消息
- `mc.server.title <title> [subtitle]` - 发送标题消息
  - `-i <seconds>` - 淡入时间(秒)
  - `-s <seconds>` - 停留时间(秒)
  - `-o <seconds>` - 淡出时间(秒)
- `mc.server.actionbar <message>` - 发送动作栏消息
- `mc.server.player` - 获取服务器在线玩家信息
- `mc.server.broadcast <message>` - 广播消息
- `mc.server.kick <player> [reason]` - 踢出玩家
- `mc.server.op <player>` - 管理管理员
  - `-r` - 移除玩家管理员权限
- `mc.server.status` - 查看服务器状态
- `mc.server.wl [player]` - 管理白名单
  - `-r` - 从白名单中移除玩家
  - `--on/--off` - 开启/关闭服务器白名单
- `mc.server.run <command>` - 执行自定义命令

所有服务器命令均支持 `-s <name>` 选项指定服务器。

### 其他功能

- `mc.ver` - 查询 Minecraft 最新版本信息
- `mc.skin <用户名>` - 查询玩家信息与皮肤

## 配置说明

### 通用配置

```yaml
common:
  useForwardMsg: false   # 启用合并转发
  totalLength: 400       # 总预览字数
  descLength: 20         # 搜索列表描述字数
  Timeout: 15            # 搜索超时时间（秒）
  captureTimeout: 3      # 截图超时时间（秒）
  maxHeight: 4096        # 截图最大高度（像素）
  waitUntil: 'domcontentloaded'  # 截图等待条件
```

### 特定功能配置

```yaml
specific:
  sectionLength: 50      # Wiki 每段预览字数
  linkCount: 4           # MCMod 相关链接显示个数
  Language: 'zh'         # Wiki 显示语言
  showImages: 'noqq'     # MCMod 简介图片展示方式: always(总是), noqq(非QQ平台), never(禁用)
  cfApi: ''              # CurseForge API Key
  showSkull: true        # 显示如何获取玩家头颅
```

### 服务器信息查询配置

```yaml
info:
  default: 'hypixel.net'   # 默认服务器地址
  showIP: false            # 是否显示服务器地址
  showIcon: true           # 是否显示服务器图标
  maxNumberDisplay: 8      # 列表最大显示个数
  javaApis:                # Java 版查询 API
    - 'https://api.mcstatus.io/v2/status/java/${address}'
    - 'https://api.mcsrvstat.us/3/${address}'
  bedrockApis:             # Bedrock 版查询 API
    - 'https://api.mcstatus.io/v2/status/bedrock/${address}'
    - 'https://api.mcsrvstat.us/bedrock/3/${address}'
```

### 版本更新检测配置

```yaml
ver:
  enabled: false       # 启用版本更新检查
  release: true        # 通知正式版本
  snapshot: true       # 通知快照版本
  interval: 20         # 检查间隔时间（分钟）
  groups:              # 接收更新通知的目标(格式: platform:type:id)
    - 'onebot:private:123456789'
    - 'discord:group:987654321'
```

### 服务器连接配置

```yaml
link:
  events:              # 监听事件类型
  servers:             # 服务器配置列表
    - name: 'default'  # 服务器名称
      group: 'sandbox:default'  # 互联群组 ID
      rcon:            # RCON 配置
        address: 'localhost:25575'
        password: ''
      websocket:       # WebSocket 配置
        mode: 'client' # 模式：client 或 server
        address: 'localhost:8080'
        token: ''
```

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
