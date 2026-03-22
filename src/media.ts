/**
 * Media processing: inbound download/decrypt, outbound encrypt/upload.
 * Markdown-to-plaintext conversion for outbound text.
 */
import { createHash, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'fs'
import { join, sep, basename, extname } from 'path'
import { homedir } from 'os'
import { aesEcbPaddedSize } from './crypto.js'
import { uploadBufferToCdn, downloadAndDecrypt, downloadPlain } from './cdn.js'
import { getUploadUrl, sendMessage } from './api.js'
import { MessageType, MessageState, MessageItemType, UploadMediaType } from './types.js'
import type { MessageItem, ImageItem, WeixinMessage } from './types.js'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// --- Security ---

export function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// --- Markdown to plain text ---

export function markdownToPlainText(text: string): string {
  let result = text
  // Code blocks: strip fences, keep content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim())
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  // Links: keep display text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Tables: remove separator rows, strip pipes
  result = result.replace(/^\|[\s:|-]+\|$/gm, '')
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split('|').map((cell) => cell.trim()).join('  '),
  )
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/\*(.+?)\*/g, '$1')
  result = result.replace(/__(.+?)__/g, '$1')
  result = result.replace(/_(.+?)_/g, '$1')
  // Inline code
  result = result.replace(/`([^`]+)`/g, '$1')
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, '')
  // Blockquotes
  result = result.replace(/^>\s?/gm, '')
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '')
  // List markers
  result = result.replace(/^(\s*)[-*+]\s+/gm, '$1')
  result = result.replace(/^(\s*)\d+\.\s+/gm, '$1')
  return result
}

// --- Text chunking ---

export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// --- Inbound media helpers ---

export function resolveAesKey(item: ImageItem): string | undefined {
  // image_item.aeskey is a raw hex string - parseAesKey handles it directly
  if (item.aeskey) return item.aeskey
  return item.media?.aes_key
}

export async function downloadInboundImage(
  encryptQueryParam: string,
  aesKeyInput: string | undefined,
  cdnBaseUrl: string,
): Promise<string> {
  mkdirSync(INBOX_DIR, { recursive: true })
  const buf = aesKeyInput
    ? await downloadAndDecrypt(encryptQueryParam, aesKeyInput, cdnBaseUrl)
    : await downloadPlain(encryptQueryParam, cdnBaseUrl)
  const path = join(INBOX_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.jpg`)
  writeFileSync(path, buf)
  return path
}

export async function downloadInboundMedia(
  encryptQueryParam: string,
  aesKey: string,
  cdnBaseUrl: string,
  ext: string,
): Promise<string> {
  mkdirSync(INBOX_DIR, { recursive: true })
  const buf = await downloadAndDecrypt(encryptQueryParam, aesKey, cdnBaseUrl)
  const path = join(INBOX_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`)
  writeFileSync(path, buf)
  return path
}

// --- Outbound: upload image ---

export async function uploadAndSendImage(opts: {
  filePath: string
  toUserId: string
  contextToken: string
  caption?: string
  baseUrl: string
  token: string
  cdnBaseUrl: string
}): Promise<string> {
  const { filePath, toUserId, contextToken, caption, baseUrl, token, cdnBaseUrl } = opts
  assertSendable(filePath)
  const plaintext = readFileSync(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)

  const aeskeyHex = aeskey.toString('hex')

  const uploadResp = await getUploadUrl({
    baseUrl, token,
    req: {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  })

  if (!uploadResp.upload_param) throw new Error('getuploadurl returned no upload_param')

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam: uploadResp.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  })

  // Send caption as separate text message if provided
  if (caption) {
    const clientId = `wechat-${Date.now()}-${randomBytes(4).toString('hex')}`
    await sendMessage({
      baseUrl, token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: caption } }],
          context_token: contextToken,
        },
      },
    })
  }

  // Send image message — aes_key must be base64(hex string), not base64(raw bytes)
  const clientId = `wechat-${Date.now()}-${randomBytes(4).toString('hex')}`
  await sendMessage({
    baseUrl, token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aeskeyHex).toString('base64'),
              encrypt_type: 1,
            },
            mid_size: filesize,
          },
        }],
        context_token: contextToken,
      },
    },
  })

  return clientId
}

// --- Outbound: upload file ---

export async function uploadAndSendFile(opts: {
  filePath: string
  toUserId: string
  contextToken: string
  caption?: string
  baseUrl: string
  token: string
  cdnBaseUrl: string
}): Promise<string> {
  const { filePath, toUserId, contextToken, caption, baseUrl, token, cdnBaseUrl } = opts
  assertSendable(filePath)
  const plaintext = readFileSync(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)
  const fileName = basename(filePath)

  const aeskeyHex = aeskey.toString('hex')

  const uploadResp = await getUploadUrl({
    baseUrl, token,
    req: {
      filekey,
      media_type: UploadMediaType.FILE,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  })

  if (!uploadResp.upload_param) throw new Error('getuploadurl returned no upload_param')

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam: uploadResp.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  })

  // Send caption as separate text message if provided
  if (caption) {
    const clientId = `wechat-${Date.now()}-${randomBytes(4).toString('hex')}`
    await sendMessage({
      baseUrl, token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: caption } }],
          context_token: contextToken,
        },
      },
    })
  }

  // Send file message — aes_key must be base64(hex string), not base64(raw bytes)
  const clientId = `wechat-${Date.now()}-${randomBytes(4).toString('hex')}`
  await sendMessage({
    baseUrl, token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aeskeyHex).toString('base64'),
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(rawsize),
          },
        }],
        context_token: contextToken,
      },
    },
  })

  return clientId
}

// --- Outbound: send text ---

export async function sendTextMessage(opts: {
  toUserId: string
  text: string
  contextToken: string
  baseUrl: string
  token: string
  textChunkLimit: number
}): Promise<number> {
  const { toUserId, text, contextToken, baseUrl, token, textChunkLimit } = opts
  const plainText = markdownToPlainText(text)
  const chunks = chunk(plainText, textChunkLimit)

  for (const c of chunks) {
    const clientId = `wechat-${Date.now()}-${randomBytes(4).toString('hex')}`
    await sendMessage({
      baseUrl, token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: c } }],
          context_token: contextToken,
        },
      },
    })
  }

  return chunks.length
}

// --- Inbound: extract text from message ---

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  )
}

export function extractText(msg: WeixinMessage): string {
  const items = msg.item_list ?? []
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const text = item.text_item.text
      const ref = item.ref_msg
      if (!ref) return text
      // Quoted media: just return the text
      if (ref.message_item && isMediaItem(ref.message_item)) return text
      // Build quoted context
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refItems = [ref.message_item]
        for (const ri of refItems) {
          if (ri.type === MessageItemType.TEXT && ri.text_item?.text) {
            parts.push(ri.text_item.text)
          }
        }
      }
      if (!parts.length) return text
      return `[引用: ${parts.join(' | ')}]\n${text}`
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}
