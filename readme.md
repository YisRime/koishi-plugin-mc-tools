# koishi-plugin-mc-tools

[![npm](https://img.shields.io/npm/v/koishi-plugin-mc-tools?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mc-tools)

我的世界(Minecraft)。可查询 MC 版本、服务器信息、玩家皮肤信息以及四大平台资源；支持管理服务器，功能梭哈

## 功能概述

- **资源查询**：查询 MCWiki、MCMOD 百科、CurseForge 和 Modrinth 上的内容
- **链接解析**：自动识别并解析聊天中的 Minecraft 相关资源链接
- **玩家信息**：查询玩家 UUID、皮肤、渲染 3D 模型和头像
- **版本功能**：查询最新版本，自动推送 Minecraft 版本更新通知
- **状态功能**：查询官方服务状态，自动推送服务状态变更通知
- **服务器信息**：查询 Java 版和基岩版服务器状态、玩家、模组和插件列表
- **服务器交互**：通过 WebSocket 连接服务器、执行 RCON 命令、发送游戏内消息
- **通知功能**：接收游戏内玩家加入、退出、聊天等事件并推送到群组

## 命令列表

### 基础命令

- `mc.ver` - 查询 Minecraft 最新版本
- `mc.status` - 查询 Minecraft 官方服务状态
- `mc.info [server]` - 查询 Java 版服务器信息
  - `mc.info.be [server]` - 查询基岩版服务器信息

`mc.info` 命令支持在服务器映射群组(`serverMaps`)中配置对应群组，以直接查询对应服务器。

- `mc.player <username>` - 查询玩家信息
  - `mc.player.skin <username>` - 获取玩家皮肤预览
    - `-e, --elytra`: 显示鞘翅
    - `-c, --cape`: 不显示披风
  - `mc.player.head <username>` - 获取玩家大头娃娃
  - `mc.player.raw <username>` - 获取玩家原始皮肤

渲染图像均支持使用 `-b, --bg <color:string>` 设置背景颜色 (HEX 格式)

### 服务器交互

所有命令均支持使用 `-s, --server <serverId:number>` 选项指定服务器 ID：

- `mc.server.say <message>` - 发送聊天消息到服务器
- `mc.server.run <command>` - 执行服务器命令
- `mc.server.bind [username]` - 白名单管理
  - `-r, --remove`: 解绑指定用户名

### 资源查询

`mc.search`命令在不指定任何选项时，会使用提供的关键词，在 Modrinth 和 CurseForge 平台进行搜索。
如果指定了 `-p` 平台选项，则会覆盖默认配置，只使用指定的平台进行搜索。
结果会进行合并，并提供交互式选择，允许用户选择查看特定结果的详情，或翻页查看更多结果。
如果缓存中结果已全部显示完毕，会自动应用偏移量进行第二次搜索并继续显示内容。

- `mc.search <keyword>` - 聚合搜索
  - `-p <platform:string>`: 指定平台 (`modrinth`, `curseforge`, `mcmod`, `mcwiki`, 可用逗号分隔)
  - `-s <sort:string>`: 排序方式 (视平台支持)
  - `-v <version:string>`: 支持版本
  - `-l <loader:string>`: 加载器
  - `-k <count:number>`: 跳过结果数
  - `-t <type:string>`: 资源类型 (视平台支持，例如: `mod`, `modpack`, `resourcepack`, `shader`等)
  - `-mrf <facets:string>`: [Modrinth] 高级过滤 (`JSON` 字符串，例如 `[["versions:1.19.2"],["project_type:mod"]]`)
  - `-cfo <order:string>`: [CurseForge] 升降序 (`asc`/`desc`)
  - `-ww <what:string>`: [MCWiki] 搜索范围 (例如: `title`, `text`, `nearmatch`)
  - `-mm`: [MCMOD] 启用复杂搜索模式
  - `-d`: 下载模式 (视平台支持)

以下命令会使用提供的关键词，在对应平台进行搜索，并直接展示第一个搜索结果的详细信息。
支持 `-s` 截图选项，使用该选项会将输出结果的网页进行截图并逐条发送。这需要 `Puppeteer` 服务。

- `mc.mcwiki <keyword>` - 查询 MCWiki 内容
  - `-k <count:number>`: 跳过结果数
  - `-w <what:string>`: 搜索范围 (例如: `title`, `text`, `nearmatch`)
  - `-e`: 精确匹配关键词
- `mc.mcmod <keyword>` - 查询 MCMOD 百科
  - `-t <type:string>`: 资源类型 (例如: `mod`, `modpack`, `item`, `post`, `author`, `user`, `community`)
  - `-m`: 启用复杂搜索模式
  - `-c`: 获取社区信息 (用于模组和整合包)
  - `-r`: 获取关联模组信息 (用于模组和整合包)
  - `-o`: 获取额外信息 (用于教程和物品)
  - `-p <page:number>`: 指定结果页码

以下命令在支持 `-s` 截图选项的基础上，还支持 `-d` 下载选项，使用该选项会获取资源的文件列表。可以选择具体文件进行下载。

- `mc.modrinth <keyword>` - 查询 Modrinth 资源
  - `-t <type:string>`: 资源类型 (例如: `mod`, `modpack`, `resourcepack`, `shader`)
  - `-v <version:string>`: 支持版本
  - `-l <loader:string>`: 加载器 (例如: `fabric`, `forge`, `quilt`)
  - `-f <facets:string>`: 高级过滤 (`JSON` 字符串或逗号分隔的 `key:value` 对)
  - `-k <count:number>`: 跳过结果数
  - `-sort <sort:string>`: 排序方式 (例如: `relevance`, `downloads`, `follows`, `new`, `updated`)
  - `-dep`: 显示依赖关系
- `mc.curseforge <keyword>` - 查询 CurseForge 资源
  - `-t <type:string>`: 资源类型 (例如: `mod`, `modpack`, `resourcepack`, `shader`等)
  - `-v <version:string>`: 支持版本
  - `-l <loader:string>`: 加载器 (例如: `forge`, `fabric`, `quilt`, `neoforge`等)
  - `-k <count:number>`: 跳过结果数

## 链接解析

支持自动识别和解析聊天消息中的以下 Minecraft 相关资源链接：

- **Modrinth** 链接：`modrinth.com/mod/project-id` 等
- **CurseForge** 链接：`curseforge.com/minecraft/mc-mods/project-name` 等
- **MCMOD 百科** 链接：`mcmod.cn/class/123.html` 等
- **Minecraft Wiki** 链接：`minecraft.wiki/w/Page_Name` 等

当用户在群聊中发送这些链接时，插件会自动获取并展示对应资源的详细信息。

## 配置说明

### 基础配置

- **查询开关配置**：
  - `linkParserEnabled`: 启用链接解析 ('disable'/'text'/'shot')
    - `disable`: 禁用链接解析功能
    - `text`: 启用链接解析，以文本形式返回结果
    - `shot`: 启用链接解析，以截图形式返回结果（需要 Puppeteer 服务）
  - `mcwikiEnabled`: 启用 MC Wiki 查询 (布尔值)
  - `modrinthEnabled`: 启用 Modrinth 查询 (布尔值)
  - `mcmodEnabled`: 启用 MCMOD 查询 (布尔值或API字符串)
  - `curseforgeEnabled`: 启用 CurseForge 查询 (布尔值或API密钥字符串)

用于控制各个资源查询功能的开启或关闭。
CurseForge API 密钥需自行申请，也可加入 QQ 群 855571375 获取作者申请的 Key 进行使用。
MC 百科内容处理调用了作者自行编写的 API，由于使用了 CloudFlare Worker，国内访问可能会受影响。

- **资源查询配置**：
  - `useForward`: 启用合并转发 (布尔值)
  - `useScreenshot`: 启用网页截图 (布尔值)
  - `useFallback`: 启用发送回退 (布尔值)
  - `maxParagraphs`: 详情段数限制 (数字)
  - `maxDescLength`: 每段字数限制 (数字)

用于调整资源查询命令的行为和显示效果。
合并转发功能仅在 `onebot` 平台可用，其余平台会自动以纯文本形式发送，网页截图功能需要 `Puppeteer` 服务支持。
`maxParagraphs` 和 `maxDescLength` 默认限制为合并转发所允许的最大长度，一般情况下无需调整。

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

- **服务状态通知配置**：
  - `statusUpdInterval`: 状态检查间隔(分钟) (数字)
  - `statusNoticeTargets`: 服务状态变更推送目标 (对象数组)
    - `platform`: 平台 ID (字符串)
    - `channelId`: 频道 ID (字符串)

配置服务状态变更的检查频率和自动推送通知的目标群组或频道。

- **服务器查询配置**：
  - `infoEnabled`: 启用服务器查询 (布尔值)
  - `serverApis`: 服务器查询 API (对象数组)
    - `type`: API 类型 ('java'/'bedrock')
    - `url`: API URL (字符串, 使用 `${address}` 指代地址)
  - `serverTemplate`: 服务器信息模板 (字符串)

用于控制服务器信息查询功能。可以自定义查询结果的显示格式。
已预先添加多个查询 API，一般情况下无需另行配置。

#### 信息模板变量

服务器信息模板支持以下变量并均已默认配置：

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

同一行内所有变量均为空时会**跳过该行**显示

### 服务器连接配置

- `bindEnabled`: 启用白名单管理 (布尔值)
- **服务器映射群组** (`serverMaps`)：设置群组与服务器的关联 (对象数组)
  - `serverId`: 服务器 ID (数字, 必填)
  - `platform`: 平台 ID (字符串)
  - `channelId`: 频道 ID (字符串)
  - `serverAddress`: 服务器地址 (字符串)

允许将特定群组关联特定 Minecraft 服务器。这样在对应群组中使用相关命令时，可无需手动指定服务器 ID 或地址。
如果开启 RCON 和`bindEnabled`选项，可支持用户自行绑定白名单，绑定列表会以文件形式保存在`data`目录下。

- **RCON配置** (`rconServers`)：配置RCON连接参数 (对象数组)
  - `id`: 服务器 ID (数字, 必填)
  - `rconAddress`: RCON地址 (字符串, 如 `localhost:25575`)
  - `rconPassword`: RCON密码 (字符串)

RCON 是一种允许远程执行服务器命令的协议。
在此处配置服务器的 RCON 地址和密码后，可以使用命令通过 RCON 与服务器交互。

## 注意事项

使用 Docker 部署时可能会出现**渲染问题**和**字体问题**。
原因：koishijs/koishi 镜像中的 Chromium 不支持 WebGL，需要安装 chromium-swiftshader。
如果插件出现皮肤渲染失败或仅显示背景，截图文字显示异常等情况，可按照以下步骤进行解决：

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
