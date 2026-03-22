/**
 * CDN upload/download for WeChat media.
 * Upload: encrypt → getuploadurl → POST to CDN → get download param
 * Download: GET from CDN → decrypt
 */
import { encryptAesEcb, decryptAesEcb, parseAesKey } from './crypto.js'

const UPLOAD_MAX_RETRIES = 3

// --- URL construction ---

export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

// --- Upload ---

export async function uploadBufferToCdn(params: {
  buf: Buffer
  uploadParam: string
  filekey: string
  cdnBaseUrl: string
  aeskey: Buffer
}): Promise<{ downloadParam: string }> {
  const { buf, uploadParam, filekey, cdnBaseUrl, aeskey } = params
  const ciphertext = encryptAesEcb(buf, aeskey)
  const cdnUrl = buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey)

  let downloadParam: string | undefined
  let lastError: unknown

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text())
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        throw new Error(`CDN upload server error: ${res.headers.get('x-error-message') ?? `status ${res.status}`}`)
      }
      downloadParam = res.headers.get('x-encrypted-param') ?? undefined
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header')
      }
      break
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes('client error')) throw err
      if (attempt >= UPLOAD_MAX_RETRIES) {
        process.stderr.write(`wechat channel: CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts: ${err}\n`)
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`)
  }
  return { downloadParam }
}

// --- Download ---

export async function downloadAndDecrypt(
  encryptedQueryParam: string,
  aesKeyInput: string,
  cdnBaseUrl: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyInput)
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`)
  }
  const encrypted = Buffer.from(await res.arrayBuffer())
  return decryptAesEcb(encrypted, key)
}

export async function downloadPlain(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
