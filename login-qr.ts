#!/usr/bin/env bun
/**
 * Step 1: Fetch QR code and render it in terminal.
 * Outputs JSON as the last line: {"qrcode":"...","url":"..."}
 * so the caller (skill) can extract the qrcode token for polling.
 *
 * Usage: bun login-qr.ts [base-url]
 */

import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Auto-install dependencies if node_modules is missing
const scriptDir = dirname(fileURLToPath(import.meta.url))
if (!existsSync(join(scriptDir, 'node_modules', 'qrcode-terminal'))) {
  Bun.spawnSync(['bun', 'install', '--no-summary'], { cwd: scriptDir, stderr: 'inherit' })
}

const BASE_URL = process.argv[2] || 'https://ilinkai.weixin.qq.com/'
const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`

const res = await fetch(`${base}ilink/bot/get_bot_qrcode?bot_type=3`)
if (!res.ok) {
  console.error(`获取二维码失败: ${res.status}`)
  process.exit(1)
}

const data = await res.json() as any
const qrcodeToken: string = data.qrcode
const url: string = data.qrcode_img_content

// Output URL first (always visible even in collapsed output)
console.log(`用微信打开以下链接完成登录：\n\n  ${url}\n`)

// Last line: structured data for the caller to parse
console.log(JSON.stringify({ qrcode: qrcodeToken, url }))
