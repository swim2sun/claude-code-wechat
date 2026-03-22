# claude-code-wechat

微信频道插件，通过 iLink Bot API 将微信消息接入 Claude Code 会话。支持文字、图片、文件、视频和语音收发。

[English](./README.en.md)

## 前置条件

- **[Claude Code](https://claude.com/claude-code)** v2.1.80+
- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`
- **微信 (iOS)** 并开启 ClawBot

## 安装

**1. 添加插件市场并安装**

```
/plugin marketplace add swim2sun/swim2sun-plugins
/plugin install wechat@swim2sun-plugins
```

安装完成后需要重启 Claude Code 以加载插件。

**2. 登录**

```
/wechat:configure login
```

用微信 (iOS) 扫描二维码完成登录。凭据保存在 `~/.claude/channels/wechat/credentials.json`。

**3. 启用频道并重启**

```sh
claude --dangerously-load-development-channels plugin:wechat@swim2sun-plugins
```

> 频道功能目前处于研究预览阶段，需要 `--dangerously-load-development-channels` 参数。待插件通过官方审核后可直接使用 `--channels`。

在微信上给你的 ClawBot 发一条消息，消息会出现在 Claude Code 会话中。

## 工作原理

```
微信 (iOS)
    |
ClawBot (iLink Bot API)
    |  长轮询 / POST
    v
claude-code-wechat (MCP Server)
    |  stdio
    v
Claude Code 会话
```

- 入站消息通过 `getupdates` 长轮询到达
- 图片收到时立即下载（CDN URL 会过期）
- 文件和视频按需通过 `download_attachment` 工具下载
- 出站媒体使用 AES-128-ECB 加密后上传到 CDN
- Claude 处理消息时微信端显示"输入中"

## 工具

| 工具 | 说明 |
| --- | --- |
| `reply` | 发送文字回复。自动将 Markdown 转为纯文本（微信不渲染 Markdown）。 |
| `send_image` | 通过 CDN 加密上传发送图片。 |
| `send_file` | 通过 CDN 加密上传发送文件附件。 |
| `download_attachment` | 下载入站媒体（文件、视频、语音）到本地 inbox。 |

## 技能

| 技能 | 说明 |
| --- | --- |
| `/wechat:configure` | 查看状态、登录、清除凭据、设置 API 地址。 |
| `/wechat:configure login` | 二维码登录。 |
| `/wechat:configure clear` | 清除已保存的凭据。 |
| `/wechat:configure baseurl <url>` | 设置自定义 API 地址。 |

## 项目结构

```
.claude-plugin/plugin.json  — 插件清单
.mcp.json                   — MCP 服务器配置
server.ts                   — 入口，MCP 服务器 + 长轮询循环
login.ts                    — 独立的二维码登录脚本
src/
  api.ts                    — iLink HTTP 客户端
  auth.ts                   — 凭据管理 + 二维码登录
  cdn.ts                    — CDN 上传/下载
  crypto.ts                 — AES-128-ECB 加解密
  media.ts                  — 媒体处理（入站下载、出站上传）
  types.ts                  — iLink 协议类型定义
skills/configure/SKILL.md   — configure 技能定义
```

## 限制

- **无消息历史** — iLink API 不提供历史消息查询
- **仅私聊** — 不支持群聊
- **不支持编辑/撤回** — 微信不支持通过 API 编辑或撤回已发消息
- **仅 iOS** — ClawBot iLink API 仅支持 iOS 版微信
- **研究预览** — 频道功能需要 `--dangerously-load-development-channels` 参数

## 开发

```sh
# 克隆并安装依赖
git clone https://github.com/swim2sun/claude-code-wechat.git
cd claude-code-wechat
bun install

# 以插件模式运行
claude --plugin-dir . --dangerously-load-development-channels server:wechat
```

如需从任意目录启动频道服务，在 `~/.claude.json` 中添加：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/claude-code-wechat", "--shell=bun", "--silent", "start"],
      "type": "stdio"
    }
  }
}
```

然后在任意目录运行 `claude --dangerously-load-development-channels server:wechat`。

## 许可证

MIT
