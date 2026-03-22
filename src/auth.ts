/**
 * WeChat QR login: fetch QR code, poll status, save credentials.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const CREDENTIALS_FILE = join(STATE_DIR, 'credentials.json')

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com/'

export type Credentials = {
  token: string
  baseUrl: string
  accountId: string
  userId?: string
}

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'))
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = CREDENTIALS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, CREDENTIALS_FILE)
}

export interface QRCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export async function fetchQRCode(baseUrl: string = DEFAULT_BASE_URL): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const res = await fetch(`${base}ilink/bot/get_bot_qrcode?bot_type=3`)
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`)
  return (await res.json()) as QRCodeResponse
}

export async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 35_000)
  try {
    const res = await fetch(
      `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      {
        headers: { 'iLink-App-ClientVersion': '1' },
        signal: controller.signal,
      },
    )
    clearTimeout(timer)
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`)
    return (await res.json()) as QRStatusResponse
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' }
    throw err
  }
}

export { STATE_DIR, CREDENTIALS_FILE, DEFAULT_BASE_URL }
