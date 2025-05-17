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
    - `-e, --elytra`: 显示鞘翅而非披风
    - `-c, --cape`: 显示披风 (如果 `-e` 和 `-c` 同时存在，优先显示鞘翅)
    - `-b, --bg <color:string>`: 设置背景颜色 (HEX格式，例如 `#FF0000`)
  - `mc.player.head <username>` - 获取玩家大头娃娃
    - `-b, --bg <color:string>`: 设置背景颜色 (HEX格式，例如 `#FF0000`)
  - `mc.player.raw <username>` - 获取玩家原始皮肤
- `mc.info [server]` - 查询Java版服务器信息
  - `mc.info.be [server]` - 查询基岩版服务器信息

### 服务器交互

- `mc.server.say <message>` - 发送聊天消息到服务器
  - `-s, --server <serverId:number>`: 指定服务器 ID
  - `-f, --format <format:string>`: 指定消息文本格式 (详见文本格式化章节)
- `mc.server.run <command>` - 执行服务器命令
  - `-s, --server <serverId:number>`: 指定服务器 ID
- `mc.server.broadcast <message>` - 发送全服广播
  - `-s, --server <serverId:number>`: 指定服务器 ID
  - `-f, --format <format:string>`: 指定广播文本格式 (详见文本格式化章节)
- `mc.server.tell <player> <message>` - 发送私聊给玩家
  - `-s, --server <serverId:number>`: 指定服务器 ID
  - `-f, --format <format:string>`: 指定私聊文本格式 (详见文本格式化章节)
- `mc.server.title <title> [subtitle]` - 发送屏幕标题
  - `-s, --server <serverId:number>`: 指定服务器 ID
  - `-f, --format <format:string>`: 指定主标题文本格式 (详见文本格式化章节, 可包含 `time` 参数)
  - `--sf, --subformat <format:string>`: 指定副标题文本格式 (详见文本格式化章节)
- `mc.server.actionbar <message>` - 发送动作栏消息
  - `-s, --server <serverId:number>`: 指定服务器 ID
  - `-f, --format <format:string>`: 指定文本格式 (详见文本格式化章节)
- `mc.server.json <jsonText>` - 发送自定义JSON消息
  - `-s, --server <serverId:number>`: 指定服务器 ID
  - `-t, --type <type:string>`: 指定消息类型 (可选项: `chat`, `broadcast`, `whisper`, `title`, `actionbar`, 默认为 `broadcast`)
  - `-p, --player <player:string>`: 指定目标玩家 (用于 `whisper` 类型)
- `mc.server.bind [username]` - 白名单管理
  - `-s, --server <serverId:number>`: 指定服务器 ID (绑定时，如果群组已映射服务器则此项可选)
  - `-r, --remove`: 解绑指定用户名

### 资源查询

- `mc.search <keyword>` - 聚合搜索
  - `-p <platform:string>`: 指定平台 (可选项: modrinth, curseforge, mcmod, mcwiki, 可用逗号分隔指定多个)
  - `-s <sort:string>`: 排序方式 (不同平台支持的排序方式不同)
  - `-v <version:string>`: 支持版本
  - `-l <loader:string>`: 加载器
  - `-k <count:number>`: 跳过结果数
  - `-t <type:string>`: 资源类型 (例如: mod, modpack, resourcepack, shader等，具体支持类型视平台而定)
  - `-mrf <facets:string>`: [Modrinth] 高级过滤 (JSON字符串格式，例如 `[["versions:1.19.2"],["project_type:mod"]]`)
  - `-cfo <order:string>`: [CurseForge] 升降序 (asc/desc)
  - `-ww <what:string>`: [MCWiki] 搜索范围 (例如: title, text, nearmatch)
  - `-mm`: [MCMOD] 启用复杂搜索模式
  - `-d`: 下载模式 (如果平台和资源支持，将尝试获取下载链接)
- `mc.mcwiki <keyword>` - 查询 MCWiki 内容
  - `-k <count:number>`: 跳过结果数
  - `-w <what:string>`: 搜索范围 (例如: title, text, nearmatch)
  - `-e`: 精确匹配关键词
  - `-s`: 截图模式
- `mc.mcmod <keyword>` - 查询 MCMOD 百科
  - `-t <type:string>`: 资源类型 (例如: mod, modpack, item, post, author, user, community)
  - `-m`: 启用复杂搜索模式
  - `-c`: 获取社区信息 (教程、讨论，主要用于模组和整合包)
  - `-r`: 获取关联模组信息 (主要用于模组和整合包)
  - `-o`: 获取额外信息 (主要用于教程和物品)
  - `-p <page:number>`: 指定结果页码
  - `-s`: 截图模式
- `mc.modrinth <keyword>` - 查询 Modrinth 资源
  - `-t <type:string>`: 资源类型 (例如: mod, modpack, resourcepack, shader)
  - `-v <version:string>`: 支持版本
  - `-l <loader:string>`: 加载器 (例如: fabric, forge, quilt)
  - `-f <facets:string>`: 高级过滤 (JSON字符串格式或逗号分隔的 `key:value` 对)
  - `-k <count:number>`: 跳过结果数
  - `-sort <sort:string>`: 排序方式 (例如: relevance, downloads, follows, new, updated)
  - `-dep`: 显示依赖关系
  - `-s`: 截图模式
  - `-d`: 下载模式
- `mc.curseforge <keyword>` - 查询 CurseForge 资源
  - `-t <type:string>`: 资源类型 (例如: mod, modpack, resourcepack, shader等，具体参考 `CF_MAPS.TYPE`)
  - `-v <version:string>`: 支持版本
  - `-l <loader:string>`: 加载器 (例如: forge, fabric, quilt, neoforge，具体参考 `CF_MAPS.LOADER`)
  - `-k <count:number>`: 跳过结果数
  - `-s`: 截图模式
  - `-d`: 下载模式

资源查询命令在不指定任何选项时，会执行以下默认操作：

- **搜索并展示详情**：会使用提供的关键词在对应平台进行搜索，并直接展示第一个搜索结果的详细信息。
- **下载模式**：对于支持 `-d` (下载) 选项的命令，使用该选项会尝试获取并展示资源的文件列表。可以选择具体文件进行下载。
- **截图模式**：对于支持 `-s` (截图) 选项的命令，使用该选项会将输出结果渲染为图片发送。这需要 `Puppeteer` 服务支持。

`mc.search` 命令在未指定 `-p` (平台) 选项时，默认会在 Modrinth 和 CurseForge 平台进行搜索。
如果指定了 `-p` (平台) 选项，则会覆盖默认选项，只使用指定的平台进行搜索。
搜索结果会进行合并，并提供交互式选择界面，允许用户选择查看特定结果的详情，或翻页查看更多结果。
搜索结果时如果已经显示完第一次获取的结果，会自动应用偏移量进行第二次搜索并继续显示内容。

## 配置说明

### 基础配置

- **查询开关配置**：
  - `mcwikiEnabled`: 启用 Minecraft Wiki 查询 (布尔值)
  - `modrinthEnabled`: 启用 Modrinth 查询 (布尔值)
  - `mcmodEnabled`: 启用 MCMOD 查询 (布尔值或API字符串)
  - `curseforgeEnabled`: 启用 CurseForge 查询 (布尔值或API密钥字符串)

用于控制各个资源查询功能的开启或关闭，未配置 API 则不会开启相关功能。
CurseForge API 密钥需自行申请，也可加入 QQ 群 855571375 获取作者申请的 Key 进行使用。
MC 百科内容处理调用了作者自行编写的 API，由于使用了 CloudFlare Worker，国内访问可能会受影响。

- **资源查询配置**：
  - `useForward`: 启用合并转发 (布尔值)
  - `useScreenshot`: 启用网页截图 (布尔值)
  - `searchDesc`: 简介长度 (数字)
  - `searchResults`: 搜索结果数/页 (数字)
  - `maxParagraphs`: 详情段落数限制 (数字)
  - `maxDescLength`: 每段字数限制 (数字)
  - `maxModLinks`: 相关链接数限制 (数字)

用于调整资源查询命令的行为和显示效果，例如是否使用合并转发或截图模式，以及返回结果的数量和内容长度。
合并转发功能仅在`onebot`平台可用，其余平台会自动以纯文本形式发送，网页截图功能需要 `Puppeteer` 服务支持。
`maxParagraphs`和`maxDescLength`默认限制为合并转发所允许的最大长度，一般情况下无需调整。

- **版本&玩家查询配置**：
  - `playerEnabled`: 启用玩家信息查询 (布尔值)
  - `verEnabled`: 启用最新版本查询 (布尔值)
  - `updInterval`: 更新检查间隔(分钟) (数字)
  - `noticeTargets`: 版本更新推送目标 (对象数组)
    - `platform`: 平台 ID (字符串)
    - `channelId`: 频道 ID (字符串)
    - `type`: 推送类型 ('release'/'snapshot'/'both')

配置是否启用玩家信息查询和最新版本查询功能。
可以设置版本更新的检查频率和自动推送通知的目标群组或频道。
查询玩家皮肤时默认不显示披风，需使用选项指定才可显示。

- **服务器查询配置**：
  - `infoEnabled`: 启用服务器查询 (布尔值)
  - `serverApis`: 服务器查询 API (对象数组)
    - `type`: API 类型 ('java'/'bedrock')
    - `url`: API URL (字符串, 使用 `${address}` 指代地址)
  - `serverTemplate`: 服务器信息模板 (字符串)

用于控制服务器信息查询功能。可以配置多个查询 API 地址，并自定义查询结果的显示格式。
已预先添加了几个常见 API 地址，一般情况下无需另行配置。
支持在服务器映射群组(`serverMaps`)中配置对应群组，以直接使用`mc.info`来查询对应服务器。

### 服务器连接配置

- `bindEnabled`: 启用白名单管理 (布尔值)
- **服务器映射群组** (`serverMaps`)：设置群组与服务器的关联 (对象数组)
  - `serverId`: 服务器 ID (数字, 必填)
  - `platform`: 平台 ID (字符串)
  - `channelId`: 频道 ID (字符串)
  - `serverAddress`: 服务器地址 (字符串)

允许将特定的聊天群组与 Minecraft 服务器进行绑定。
在这些群组中使用服务器相关命令时，可以自动识别目标服务器，无需用户手动指定服务器ID或地址。
如果开启 RCON 和`bindEnabled`选项，可支持用户自行绑定白名单，绑定列表会以文件形式保存在`data`目录下。

- **RCON配置** (`rconServers`)：配置RCON连接参数 (对象数组)
  - `id`: 服务器 ID (数字, 必填)
  - `rconAddress`: RCON地址 (字符串, 如 `localhost:25575`)
  - `rconPassword`: RCON密码 (字符串)

RCON 是一种允许远程执行服务器命令的协议。
在此处配置服务器的 RCON 地址和密码后，可以使用命令通过 RCON 与服务器交互。

- **WebSocket配置** (`wsServers`)：设置WebSocket连接参数 (对象数组)
  - `id`: 服务器 ID (数字, 必填)
  - `name`: 服务器名称 (字符串)
  - `websocketMode`: WebSocket模式 ('client'/'server')
  - `websocketAddress`: WebSocket地址 (字符串, 如 `localhost:8080`)
  - `websocketToken`: WebSocket认证令牌 (字符串)

WebSocket 配置用于与 Minecraft 服务器上的**鹊桥**插件建立双向通信。
能够接收来自服务器的实时事件（如玩家聊天、加入/退出游戏等）并推送到群组，同时也可以通过 WebSocket 发送消息到服务器。

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

以上所有变量均已默认在`serverTemplate`中配置，可以自行配置。
当同一行的所有变量均为空时，该行所有文本均会被跳过。

## 文本格式化

使用对应命令发送消息到服务器时，可以使用特定的格式化代码来丰富消息内容。

- `color:颜色名` 或 `c:颜色名`: 设置后续文本的颜色。为 Minecraft 标准的颜色名称。
- `font:字体`: 设置后续文本的字体。
- `bold` 或 `b`: 使后续文本变为**粗体**。
- `italic` 或 `i`: 使后续文本变为*斜体*。
- `underlined` 或 `u`: 为后续文本添加`下划线`。
- `strikethrough` 或 `s`: 为后续文本添加~~删除线~~。
- `obfuscated` 或 `o`: 使后续文本显示为 Minecraft 中的“乱码”效果。
- `click:action=值`: 为文本添加点击事件。当玩家在游戏中点击这段文本时，会执行指定的操作。
  - `action` 的可用值:
    - `url`: 打开一个URL链接。`值` 是要打开的网址 (例如 `click:url=https://github.com/YisRime/koishi-plugin-mc-tools`)。
    - `run`: 执行一条 Minecraft 命令。`值` 是要执行的命令 (例如 `click:run=/say Hello from Yis_Rime!`)。
    - `suggest`: 在聊天框中预先填入一条命令或文本。`值` 是要建议的内容 (例如 `click:suggest=/msg Hello from Yis_Rime!`)。
    - `copy`: 将指定的文本复制到玩家的剪贴板。`值` 是要复制的文本 (例如 `click:copy=这是重要的信息`)。
- `hover:action=值`: 为文本添加悬浮事件。当玩家的鼠标光标悬停在这段文本上时，会显示额外的信息。
  - `action` 的可用值:
    - `text`: 显示一段纯文本提示。`值` 是要显示的悬浮文本 (例如 `hover:text=这是一个提示信息`)。
    - `item`: 显示一个游戏内物品的信息。`值` 通常是物品的ID，可以包含NBT数据 (例如 `hover:item=minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]}`)。
    - `entity`: 显示一个游戏内实体的信息。`值` 通常包含实体的类型、名称或UUID (例如 `hover:entity={type:"minecraft:pig",name:"猪"}`)。
- `insert:文本`: 当玩家在游戏中点击这段文本时，会将指定的 `文本` 直接插入到他们的聊天框中光标所在位置。
- `time:淡入,停留,淡出`: (用于 `mc.server.title` 命令) 设置屏幕标题的显示时间参数。
  - `淡入`: 标题内容渐显出来所需的时间（以游戏刻为单位，20刻=1秒）。
  - `停留`: 标题内容完全显示后保持可见的时间（单位同上）。
  - `淡出`: 标题内容渐隐消失所需的时间（单位同上）。
  - 示例: `time:20,60,20` 表示标题淡入1秒，停留3秒，然后淡出1秒。

**格式化示例:**
`mc.server.broadcast -f "bold color:gold click:url=https://github.com/YisRime hover:text=GitHub" "前往作者主页"`
这条命令会发送一条粗体的金色广播消息 "前往作者主页"，点击该消息会打开作者的 GitHub 主页，鼠标悬停会显示 "GitHub"。

## 注意事项

截图与皮肤渲染功能依赖 Puppeteer 服务。
以下问题仅可能出现在使用 Docker 部署的情况：

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
# 删除原有 Chromium（latest-lite 镜像用户可跳过此步）
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
docker exec -it <容器ID> rm -f /tmp/NotoSansCJKsc-hinted.zip
```

完成上述步骤后重启 Puppeteer 插件即可正常使用，无需添加 `--disable-gpu` 参数
