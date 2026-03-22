---
name: configure
description: Set up the WeChat channel — run QR login, check credentials status, review access policy. Use when the user wants to configure WeChat, asks to log in, asks "how do I set this up," or wants to check channel status.
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

Manages credentials in `~/.claude/channels/wechat/credentials.json` and orients
the user on access policy. The server reads this file at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/wechat/credentials.json`. Show
   set/not-set; if set, show `accountId` and `userId` fields, and mask the
   `token` value (first 8 chars + `...`).

2. **Access** — read `~/.claude/channels/wechat/access.json` (missing file =
   defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and list of IDs
   - Pending pairings: count, with codes and sender IDs if any

3. **What next** — end with a concrete next step based on state:
   - No credentials → *"Run `/wechat:configure login` to start the QR login
     flow."*
   - Credentials set, policy is pairing, nobody allowed → *"Send a message to
     your ClawBot on WeChat. It replies with a code; approve with
     `/wechat:access pair <code>`."*
   - Credentials set, someone allowed → *"Ready. Message your ClawBot on WeChat
     to reach the assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture WeChat user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/wechat:access policy allowlist`. Do this proactively — don't wait to be
   asked.
4. **If no, people are missing** → *"Have them message the bot; you'll approve
   each with `/wechat:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"Message your ClawBot to capture your own ID first. Then we'll add anyone
   else and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"Have them message the bot briefly while you
   flip to pairing: `/wechat:access policy pairing` → they message → you pair
   → flip back to `/wechat:access policy allowlist`."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `login` — QR login flow

Initiates the WeChat QR login flow using the standalone login script.

1. `mkdir -p ~/.claude/channels/wechat`
2. If credentials already exist, read them and warn the user: *"已有凭据
   (accountId: `<accountId>`). 继续登录将覆盖。是否继续？"* — wait for
   confirmation before proceeding.
3. Find the plugin root directory — it contains `login.ts`. Look for it at:
   `${CLAUDE_PLUGIN_ROOT}/login.ts` or resolve from the skill's own path
   (two directories up from this SKILL.md file).
4. Run the login script. **This is a long-running interactive command** — it
   renders a QR code in terminal, waits for the user to scan, and may take up
   to 8 minutes. **Do not set a short timeout.** Run:
   ```
   bun ${PLUGIN_ROOT}/login.ts
   ```
   where `${PLUGIN_ROOT}` is the resolved plugin root directory.
5. The script handles everything: QR display, polling, credential save, and
   auto-adding the user to the allowlist.
6. On success, tell the user: *"重启 Claude Code 会话以启用微信频道。"*
7. On failure/timeout, tell the user to run `/wechat:configure login` again.

**Finding the plugin root:** The most reliable way is to check common locations:
- Use `ls` to find `login.ts` in the plugin cache:
  `ls ~/.claude/plugins/cache/*/wechat/*/login.ts` or
  `ls ~/.claude/plugins/cache/xiangyang-plugins/wechat/*/login.ts`
- Or if loaded via `--plugin-dir`, it will be at the original source path.

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
- `access.json` is re-read on every inbound message — policy changes via
  `/wechat:access` take effect immediately, no restart needed.
- Pretty-print JSON with 2-space indent so it's hand-editable.
- `credentials.json` must always be `chmod 600` — it contains the bot token.
- WeChat user IDs have the format `xxx@im.wechat`; bot IDs have the format
  `xxx@im.bot`.
