# claude-code-wechat

WeChat channel plugin for Claude Code — bridge WeChat messages into your Claude Code session via the iLink Bot API. Supports text, image, file, video and voice.

[中文](./README.md)

## Prerequisites

- **[Claude Code](https://claude.com/claude-code)** v2.1.80+
- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`
- **WeChat (iOS)** with ClawBot enabled

## Install

**1. Add marketplace and install plugin**

```
/plugin marketplace add swim2sun/swim2sun-plugins
/plugin install wechat@swim2sun-plugins
```

Restart Claude Code after installation to load the plugin.

**2. Login**

```
/wechat:configure login
```

Scan the QR code with WeChat (iOS). Credentials are saved to `~/.claude/channels/wechat/credentials.json`.

**3. Restart with channel enabled**

```sh
claude --dangerously-load-development-channels plugin:wechat@swim2sun-plugins
```

> Channels are in research preview. The `--dangerously-load-development-channels` flag is required until the plugin is approved on the official allowlist.

Send a message to your ClawBot on WeChat — it arrives in your Claude Code session.

## How it works

```
WeChat (iOS)
    |
ClawBot (iLink Bot API)
    |  long-poll / POST
    v
claude-code-wechat (MCP Server)
    |  stdio
    v
Claude Code Session
```

- Inbound messages arrive via `getupdates` long-poll
- Images are downloaded eagerly (CDN URLs expire)
- Files and videos are downloaded on demand via `download_attachment`
- Outbound media is AES-128-ECB encrypted and uploaded to CDN
- Typing indicator is shown while Claude is processing

## Tools

| Tool | Description |
| --- | --- |
| `reply` | Send text reply. Auto-converts markdown to plain text (WeChat doesn't render markdown). |
| `send_image` | Send an image file via encrypted CDN upload. |
| `send_file` | Send a file attachment via encrypted CDN upload. |
| `download_attachment` | Download inbound media (file, video, voice) to local inbox. |

## Skills

| Skill | Description |
| --- | --- |
| `/wechat:configure` | Check status, login, clear credentials, set base URL. |
| `/wechat:configure login` | QR code login flow. |
| `/wechat:configure clear` | Remove saved credentials. |
| `/wechat:configure baseurl <url>` | Set custom API base URL. |

## Project structure

```
.claude-plugin/plugin.json  — plugin manifest
.mcp.json                   — MCP server config
server.ts                   — entry point, MCP server + long-poll loop
login.ts                    — standalone QR login script
src/
  api.ts                    — iLink HTTP client
  auth.ts                   — credential management + QR login helpers
  cdn.ts                    — CDN upload/download
  crypto.ts                 — AES-128-ECB encryption
  media.ts                  — media processing (inbound download, outbound upload)
  types.ts                  — iLink protocol type definitions
skills/configure/SKILL.md   — configure skill definition
```

## Limitations

- **No message history** — iLink API has no history endpoint
- **DMs only** — group chats are not supported
- **No edit/recall** — WeChat doesn't support editing or recalling bot messages
- **iOS only** — ClawBot iLink API is iOS-specific
- **Research preview** — channels require `--dangerously-load-development-channels` until approved

## Development

```sh
# Clone and install dependencies
git clone https://github.com/swim2sun/claude-code-wechat.git
cd claude-code-wechat
bun install

# Run with plugin mode
claude --plugin-dir . --dangerously-load-development-channels server:wechat
```

For the channel server to work from any directory, add to `~/.claude.json`:

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

Then start with `claude --dangerously-load-development-channels server:wechat` from any directory.

## License

MIT
