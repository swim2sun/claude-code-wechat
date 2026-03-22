---
name: configure
description: Set up the WeChat channel — run QR login or check credentials status. Use when the user wants to configure WeChat, asks to log in, asks "how do I set this up," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(bun *)
  - Bash(chmod *)
---

# /wechat:configure — WeChat Channel Setup

Manages credentials in `~/.claude/channels/wechat/credentials.json`.
The server reads this file at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read the credentials file and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/wechat/credentials.json`. Show
   set/not-set; if set, show `accountId` and `userId` fields, and mask the
   `token` value (first 8 chars + `...`).

2. **What next** — end with a concrete next step based on state:
   - No credentials → *"Run `/wechat:configure login` to start the QR login
     flow."*
   - Credentials set → *"Ready. Restart Claude Code with
     `--dangerously-load-development-channels server:wechat` to enable the
     channel."*

3. **Available commands** — always show at the end:
   - `/wechat:configure login` — 扫码登录微信
   - `/wechat:configure clear` — 清除已保存的凭据
   - `/wechat:configure baseurl <url>` — 设置自定义 API 地址

### `login` — QR login flow

**Before running the script**, tell the user:
*"脚本运行后，请按 ctrl+o 展开输出查看完整二维码，或直接在微信中打开输出中的链接完成登录。"*

Then run directly:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/login.ts
```

`${CLAUDE_PLUGIN_ROOT}` is automatically expanded by Claude Code to the plugin's
absolute path — do NOT substitute it yourself or search for the script.

**This is a long-running command** — it renders a QR code, then polls for scan
confirmation. It may take up to 8 minutes. **Set timeout to at least 8 minutes.**

Do NOT read credentials first. Do NOT search for the script path. Just run it.

The script handles everything:
- Renders QR code in terminal
- Shows a direct URL (user can open in WeChat)
- Polls for scan confirmation
- On `confirmed`: saves credentials
- Outputs status and JSON result

On success, tell the user:
- *"✅ 微信连接成功！"*
- Credentials saved
- *"重启 Claude Code 会话以启用微信频道"*

On failure (expired/timeout), offer to run `/wechat:configure login` again.

### `clear` — remove credentials

1. Read `~/.claude/channels/wechat/credentials.json` if it exists; note the
   `accountId` so the user knows what was removed.
2. Delete the file (use `Bash` to `rm -f`).
3. Confirm: *"Credentials for `<accountId>` removed. The server will fail to
   start without valid credentials."*

### `baseurl <url>` — set custom API base URL

1. `mkdir -p ~/.claude/channels/wechat`
2. Read existing `~/.claude/channels/wechat/credentials.json` if present.
3. If present: update `baseUrl` field, write back.
4. If not present: create a minimal JSON with just `{"baseUrl": "<url>"}`.
5. `chmod 600 ~/.claude/channels/wechat/credentials.json`
6. Confirm: *"Base URL set to `<url>`. This takes effect on next server start."*

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `credentials.json` once at boot. Credential changes need a
  session restart. Say so after saving.
- Pretty-print JSON with 2-space indent so it's hand-editable.
- `credentials.json` must always be `chmod 600` — it contains the bot token.
