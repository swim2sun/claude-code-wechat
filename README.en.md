# claude-code-wechat

WeChat channel plugin for Claude Code — bridge WeChat messages into your Claude Code session via the iLink Bot API. Supports text, image, file, video and voice.

[中文](./README.md)

<img src="./docs/screenshot.png" width="300" />

## Prerequisites

- **[Claude Code](https://claude.com/claude-code)** v2.1.80+
- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`
- **WeChat** 8.0.70+

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

Press ctrl+o to expand the output and view the full QR code, or open the URL in WeChat to log in. Press ctrl+o again to collapse after login.

**3. Enable channel**

Restart Claude Code with the channel flag:

```sh
claude --dangerously-load-development-channels plugin:wechat@swim2sun-plugins
```

> It's recommended to add `--dangerously-skip-permissions` as well, otherwise file edits and command executions will frequently prompt for permission. Permission prompts only appear in the Claude Code terminal, not in WeChat.

Send a message to your ClawBot on WeChat — it arrives in your Claude Code session.

## License

MIT
