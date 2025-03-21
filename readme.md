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

- `mcwiki <关键词>` - 查询 Minecraft Wiki
- `mcwiki.find <关键词>` - 搜索 Wiki 页面
- `mcwiki.shot <关键词>` - 截图 Wiki 页面

### 模组相关命令

- `mcmod <关键词>` - 查询 MCMod
- `mcmod.find <关键词>` - 搜索 MCMod
- `mcmod.shot <关键词>` - 截图 MCMod 页面
- `mcmod.mr <关键词> [类型]` - 查询 Modrinth
- `mcmod.findmr <关键词> [类型]` - 搜索 Modrinth
- `mcmod.cf <关键词> [类型]` - 查询 CurseForge
- `mcmod.findcf <关键词> [类型]` - 搜索 CurseForge

### 服务器管理命令

- `mcinfo [server]` - 查询 Java 版服务器信息
- `mcinfo.be [server]` - 查询 Bedrock 版服务器信息
- `mcrun <message:text>` - 在服务器发送消息
- `mcrun.wl [player:string]` - 管理服务器白名单
  - `-r` - 从白名单中移除玩家
  - `--on/--off` - 开启/关闭服务器白名单
- `mcrun.op <player:string>` - 管理服务器管理员
  - `-r` - 移除玩家管理员权限
- `mcrun.kick <player:string> [reason:text]` - 踢出指定玩家
- `mcrun.ban <player:string> [reason:text]` - 封禁指定玩家
  - `--ip` - 封禁IP地址
- `mcrun.run [...args]` - 执行服务器自定义命令
  - 可通过配置中的授权用户列表或权限等级来限制使用

### 其他功能

- `mcver` - 查询 Minecraft 最新版本信息
- `mcskin <用户名>` - 查询玩家信息与皮肤

## 配置说明

### 通用设置

```yaml
wiki:
  totalLength: 400      # 总预览字数
  descLength: 20       # 搜索内容描述字数
  Timeout: 15         # 搜索超时时间（秒）
  captureTimeout: 3   # 截图超时时间（秒）
  maxHeight: 4096    # 截图最大高度（像素），0表示无限制
  waitUntil: 'domcontentloaded'  # 截图等待条件
```

### 查询设置

```yaml
search:
  Language: 'zh'      # Wiki 显示语言，支持多语言切换
  sectionLength: 50   # Wiki 每段预览字数
  linkCount: 4       # MCMod 相关链接最大显示数
  showImages: 'noqq'  # MCMod 简介图片展示方式: always(总是), noqq(非QQ平台), never(禁用)
  cfApi: ''         # CurseForge API Key
```

### 服务器设置

```yaml
info:
  default: 'hypixel.net'   # 默认服务器地址
  defaultRcon: 'localhost:25575'  # 默认 RCON 地址
  showIP: false            # 是否显示服务器地址
  showIcon: true          # 是否显示服务器图标
  maxNumberDisplay: 8     # 列表最大显示数
  showSkull: true        # 是否显示头颅获取命令
  rconPassword: ''     # RCON 密码
  authorizedRunUsers: [] # 允许使用自定义 RCON 命令的用户ID
  javaApis:           # Java 版查询 API
    - 'https://api.mcstatus.io/v2/status/java/${address}'
    - 'https://api.mcsrvstat.us/3/${address}'
  bedrockApis:       # Bedrock 版查询 API
    - 'https://api.mcstatus.io/v2/status/bedrock/${address}'
```

### 更新检测设置

```yaml
ver:
  enabled: false       # 启用版本更新检查
  release: true       # 通知正式版本
  snapshot: true      # 通知快照版本
  interval: 20        # 检查间隔时间（分钟）
  groups:             # 接收更新通知的目标(格式: platform:type:id)
    - 'onebot:private:123456789'
    - 'discord:group:987654321'
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
