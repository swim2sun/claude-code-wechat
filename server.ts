#!/usr/bin/env bun
/**
 * WeChat channel for Claude Code.
 *
 * MCP server with media support and long-poll message bridge.
 * State lives in ~/.claude/channels/wechat/ — managed by /wechat:configure skill.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'

import { loadCredentials, STATE_DIR, DEFAULT_CDN_BASE_URL } from './src/auth.js'
import { getUpdates, getConfig, sendTyping } from './src/api.js'
import { MessageType, MessageItemType, TypingStatus } from './src/types.js'
import type { WeixinMessage } from './src/types.js'
import {
  extractText, sendTextMessage, uploadAndSendImage, uploadAndSendFile,
  downloadInboundImage, downloadInboundMedia, resolveAesKey, safeName,
} from './src/media.js'
import { downloadAndDecrypt } from './src/cdn.js'

// --- Load credentials ---

const creds = loadCredentials()
if (!creds?.token || !creds?.baseUrl) {
  process.stderr.write(
    `wechat channel: credentials required\n` +
    `  run /wechat:configure login in Claude Code to scan QR and login\n`,
  )
  process.exit(1)
}

const TOKEN = creds.token
const BASE_URL = creds.baseUrl.endsWith('/') ? creds.baseUrl : `${creds.baseUrl}/`
// CDN is on a separate domain from the API
const CDN_BASE_URL = DEFAULT_CDN_BASE_URL

const INBOX_DIR = join(STATE_DIR, 'inbox')
const SYNC_BUF_FILE = join(STATE_DIR, 'sync_buf.txt')

// --- Context token cache ---
// Bounded context token cache — keeps latest 100 entries
const MAX_CONTEXT_TOKENS = 100
const contextTokenMap = new Map<string, string>()

function setContextToken(userId: string, token: string): void {
  contextTokenMap.set(userId, token)
  if (contextTokenMap.size > MAX_CONTEXT_TOKENS) {
    // Delete oldest entry (first inserted)
    const oldest = contextTokenMap.keys().next().value
    if (oldest) contextTokenMap.delete(oldest)
  }
}

// --- Typing indicator ---
// Continuous typing with keepalive every 5s, explicit CANCEL on reply.
let typingTicket: string | undefined
let typingTimer: ReturnType<typeof setInterval> | undefined
let typingUserId: string | undefined

async function refreshTypingTicket(userId: string, contextToken?: string): Promise<void> {
  try {
    const resp = await getConfig({ baseUrl: BASE_URL, token: TOKEN, ilinkUserId: userId, contextToken })
    if (resp.typing_ticket) typingTicket = resp.typing_ticket
  } catch {}
}

function startTyping(userId: string): void {
  stopTyping(false) // stop previous without sending CANCEL
  typingUserId = userId
  const send = () => {
    if (typingTicket && typingUserId) {
      void sendTyping({
        baseUrl: BASE_URL, token: TOKEN,
        body: { ilink_user_id: typingUserId, typing_ticket: typingTicket, status: TypingStatus.TYPING },
      }).catch(() => {})
    }
  }
  send()
  typingTimer = setInterval(send, 5000)
}

function stopTyping(cancel = true): void {
  if (typingTimer) {
    clearInterval(typingTimer)
    typingTimer = undefined
  }
  if (cancel && typingTicket && typingUserId) {
    void sendTyping({
      baseUrl: BASE_URL, token: TOKEN,
      body: { ilink_user_id: typingUserId, typing_ticket: typingTicket, status: TypingStatus.CANCEL },
    }).catch(() => {})
  }
  typingUserId = undefined
}

// --- Error handling ---
process.on('unhandledRejection', err => {
  process.stderr.write(`wechat channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`wechat channel: uncaught exception: ${err}\n`)
})

// --- MCP Server ---

const mcp = new Server(
  { name: 'wechat', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The sender reads WeChat, not this session. Anything you want them to see must go through the reply, send_image, or send_file tools — your transcript output never reaches their chat.',
      '',
      'Messages from WeChat arrive as <channel source="wechat" user_id="..." context_token="..." ts="...">. If the tag has image_path, Read that file — it is a photo the sender attached. If the tag has attachment_path, Read that file. If the tag has attachment_encrypt_query_param, call download_attachment to fetch the file, then Read the returned path. Reply with the reply tool — pass user_id and context_token back. Use send_image to send image files and send_file to send other files.',
      '',
      'WeChat does not render markdown. The reply tool auto-converts markdown to plain text. Do not manually format with markdown syntax.',
      '',
      "WeChat has no message history or search API. If you need earlier context, ask the user to paste it or summarize.",
      '',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply on WeChat. Pass user_id and context_token from the inbound message. Markdown is auto-converted to plain text.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'from_user_id from the inbound message' },
          text: { type: 'string' },
          context_token: { type: 'string', description: 'context_token from the inbound message. Required for delivery.' },
        },
        required: ['user_id', 'text', 'context_token'],
      },
    },
    {
      name: 'send_image',
      description: 'Send an image to a WeChat user. Pass absolute file path. Uploads via encrypted CDN.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          file_path: { type: 'string', description: 'Absolute path to local image file' },
          context_token: { type: 'string' },
          caption: { type: 'string', description: 'Optional text caption sent before the image' },
        },
        required: ['user_id', 'file_path', 'context_token'],
      },
    },
    {
      name: 'send_file',
      description: 'Send a file attachment to a WeChat user. Pass absolute file path. Uploads via encrypted CDN.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          file_path: { type: 'string', description: 'Absolute path to local file' },
          context_token: { type: 'string' },
          caption: { type: 'string', description: 'Optional text caption sent before the file' },
        },
        required: ['user_id', 'file_path', 'context_token'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download a media attachment from an inbound WeChat message to local inbox. Returns the local file path ready to Read.',
      inputSchema: {
        type: 'object',
        properties: {
          encrypt_query_param: { type: 'string', description: 'CDN download parameter from inbound meta' },
          aes_key: { type: 'string', description: 'AES key from inbound meta' },
          file_type: { type: 'string', enum: ['image', 'file', 'video', 'voice'], description: 'Type of media' },
        },
        required: ['encrypt_query_param', 'aes_key', 'file_type'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        stopTyping()
        const userId = args.user_id as string
        const text = args.text as string
        const contextToken = args.context_token as string
        if (!contextToken) throw new Error('context_token is required')
        const count = await sendTextMessage({
          toUserId: userId, text, contextToken,
          baseUrl: BASE_URL, token: TOKEN, textChunkLimit: 4000,
        })
        return { content: [{ type: 'text', text: `sent ${count} chunk(s)` }] }
      }
      case 'send_image': {
        stopTyping()
        const userId = args.user_id as string
        const filePath = args.file_path as string
        const contextToken = args.context_token as string
        const caption = args.caption as string | undefined
        if (!contextToken) throw new Error('context_token is required')
        const clientId = await uploadAndSendImage({
          filePath, toUserId: userId, contextToken, caption,
          baseUrl: BASE_URL, token: TOKEN, cdnBaseUrl: CDN_BASE_URL,
        })
        return { content: [{ type: 'text', text: `image sent (id: ${clientId})` }] }
      }
      case 'send_file': {
        stopTyping()
        const userId = args.user_id as string
        const filePath = args.file_path as string
        const contextToken = args.context_token as string
        const caption = args.caption as string | undefined
        if (!contextToken) throw new Error('context_token is required')
        const clientId = await uploadAndSendFile({
          filePath, toUserId: userId, contextToken, caption,
          baseUrl: BASE_URL, token: TOKEN, cdnBaseUrl: CDN_BASE_URL,
        })
        return { content: [{ type: 'text', text: `file sent (id: ${clientId})` }] }
      }
      case 'download_attachment': {
        const encryptQueryParam = args.encrypt_query_param as string
        const aesKey = args.aes_key as string
        const fileType = args.file_type as string
        const extMap: Record<string, string> = { image: 'jpg', file: 'bin', video: 'mp4', voice: 'silk' }
        const ext = extMap[fileType] ?? 'bin'
        const path = await downloadInboundMedia(encryptQueryParam, aesKey, CDN_BASE_URL, ext)
        return { content: [{ type: 'text', text: path }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// --- Connect MCP transport ---

await mcp.connect(new StdioServerTransport())

// --- Inbound message handler ---

async function handleInbound(msg: WeixinMessage): Promise<void> {
  if (msg.message_type !== MessageType.USER) return
  const senderId = msg.from_user_id
  if (!senderId) return

  // Cache context_token
  if (msg.context_token) setContextToken(senderId, msg.context_token)

  // Start continuous typing (stops with CANCEL when reply is sent)
  if (typingTicket) {
    startTyping(senderId)
  } else if (msg.context_token) {
    void refreshTypingTicket(senderId, msg.context_token).then(() => startTyping(senderId))
  }

  // Process message content
  const text = extractText(msg)
  const ts = msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : new Date().toISOString()

  const meta: Record<string, string> = {
    user_id: senderId,
    ts,
  }
  if (msg.context_token) meta.context_token = msg.context_token

  // Handle media
  const items = msg.item_list ?? []
  for (const item of items) {
    if (item.type === MessageItemType.IMAGE && item.image_item?.media?.encrypt_query_param) {
      // Eager download for images (CDN URLs expire)
      try {
        const aesKey = resolveAesKey(item.image_item)
        const imagePath = await downloadInboundImage(
          item.image_item.media.encrypt_query_param,
          aesKey,
          CDN_BASE_URL,
        )
        meta.image_path = imagePath
      } catch (err) {
        process.stderr.write(`wechat channel: image download failed: ${err}\n`)
      }
    } else if (item.type === MessageItemType.VOICE && item.voice_item) {
      // Voice: text is in extractText. Eagerly download silk (CDN URLs expire).
      if (item.voice_item.media?.encrypt_query_param && item.voice_item.media?.aes_key) {
        try {
          const voicePath = await downloadInboundMedia(
            item.voice_item.media.encrypt_query_param,
            item.voice_item.media.aes_key,
            CDN_BASE_URL,
            'silk',
          )
          meta.attachment_path = voicePath
          meta.attachment_kind = 'voice'
        } catch (err) {
          process.stderr.write(`wechat channel: voice download failed: ${err}\n`)
          // Fallback to lazy download refs
          meta.attachment_kind = 'voice'
          meta.attachment_encrypt_query_param = item.voice_item.media.encrypt_query_param
          meta.attachment_aes_key = item.voice_item.media.aes_key
        }
      }
    } else if (item.type === MessageItemType.FILE && item.file_item) {
      if (item.file_item.media?.encrypt_query_param && item.file_item.media?.aes_key) {
        meta.attachment_kind = 'file'
        meta.attachment_encrypt_query_param = item.file_item.media.encrypt_query_param
        meta.attachment_aes_key = item.file_item.media.aes_key
        if (item.file_item.file_name) meta.attachment_name = safeName(item.file_item.file_name) ?? ''
      }
    } else if (item.type === MessageItemType.VIDEO && item.video_item) {
      if (item.video_item.media?.encrypt_query_param && item.video_item.media?.aes_key) {
        meta.attachment_kind = 'video'
        meta.attachment_encrypt_query_param = item.video_item.media.encrypt_query_param
        meta.attachment_aes_key = item.video_item.media.aes_key
      }
    }
  }

  const content = text || (meta.image_path ? '(photo)' : meta.attachment_kind ? `(${meta.attachment_kind})` : '(empty message)')

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  }).catch(err => {
    process.stderr.write(`wechat channel: failed to deliver inbound to Claude: ${err}\n`)
  })
}

// --- Long-poll loop ---

let getUpdatesBuf = ''
try {
  getUpdatesBuf = readFileSync(SYNC_BUF_FILE, 'utf8').trim()
} catch {}

const MAX_FAILURES = 3
const BACKOFF_MS = 30_000
const RETRY_MS = 2_000
let failures = 0

async function pollLoop(): Promise<void> {
  process.stderr.write(`wechat channel: long-poll started (${BASE_URL})\n`)

  while (true) {
    try {
      const resp = await getUpdates({
        baseUrl: BASE_URL,
        token: TOKEN,
        getUpdatesBuf,
      })

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0)

      if (isError) {
        failures++
        const errMsg = `wechat channel: getUpdates error ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${failures}/${MAX_FAILURES})`
        process.stderr.write(errMsg + '\n')
        if (resp.errcode === -14) {
          process.stderr.write('wechat channel: session timeout — re-login with /wechat:configure login\n')
        }
        if (failures >= MAX_FAILURES) {
          failures = 0
          await Bun.sleep(BACKOFF_MS)
        } else {
          await Bun.sleep(RETRY_MS)
        }
        continue
      }

      failures = 0

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf
        mkdirSync(STATE_DIR, { recursive: true })
        const syncTmp = SYNC_BUF_FILE + '.tmp'
        writeFileSync(syncTmp, getUpdatesBuf)
        renameSync(syncTmp, SYNC_BUF_FILE)
      }

      const msgs = resp.msgs ?? []
      for (const msg of msgs) {
        await handleInbound(msg).catch(err => {
          process.stderr.write(`wechat channel: message handler error: ${err}\n`)
        })
      }
    } catch (err) {
      failures++
      process.stderr.write(`wechat channel: poll error (${failures}/${MAX_FAILURES}): ${err}\n`)
      if (failures >= MAX_FAILURES) {
        failures = 0
        await Bun.sleep(BACKOFF_MS)
      } else {
        await Bun.sleep(RETRY_MS)
      }
    }
  }
}

// --- Shutdown ---

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('wechat channel: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// --- Start ---

pollLoop()
