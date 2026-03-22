#!/usr/bin/env bun
/**
 * Standalone QR login script for WeChat channel.
 * Usage: bun login.ts [base-url]
 *
 * Renders QR code in terminal, polls for scan, saves credentials on success.
 */

import { fetchQRCode, pollQRStatus, saveCredentials, DEFAULT_BASE_URL } from './src/auth.js'

const baseUrl = process.argv[2] || DEFAULT_BASE_URL

process.stderr.write('正在获取微信登录二维码...\n\n')

const qr = await fetchQRCode(baseUrl)

// Show URL first (always visible even if output is collapsed)
process.stderr.write(`\n请在微信中打开以下链接完成登录：\n\n`)
process.stderr.write(`  ${qr.qrcode_img_content}\n\n`)

// Render QR in terminal via stderr (won't be collapsed by Claude Code)
try {
  const qt = (await import('qrcode-terminal')).default
  await new Promise<void>((resolve) => {
    qt.generate(qr.qrcode_img_content, { small: true }, (code: string) => {
      process.stderr.write(code + '\n')
      resolve()
    })
  })
} catch {
  // Fallback if qrcode-terminal fails
}

process.stderr.write('等待扫码...（扫码登录后按 ctrl+o 关闭二维码）\n\n')

const deadline = Date.now() + 480_000
let scannedShown = false

while (Date.now() < deadline) {
  const status = await pollQRStatus(baseUrl, qr.qrcode)

  switch (status.status) {
    case 'wait':
      break
    case 'scaned':
      if (!scannedShown) {
        console.log('👀 已扫码，请在微信中确认...')
        scannedShown = true
      }
      break
    case 'expired':
      console.log('二维码已过期，请重新运行。')
      process.exit(1)
    case 'confirmed': {
      if (!status.ilink_bot_id || !status.bot_token) {
        console.error('登录确认但未返回 bot 信息')
        process.exit(1)
      }
      const creds = {
        token: status.bot_token,
        baseUrl: status.baseurl || baseUrl,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
      }
      saveCredentials(creds)

      console.log('\n✅ 微信连接成功！')
      console.log(`   账号 ID: ${creds.accountId}`)
      console.log(`   用户 ID: ${creds.userId}`)
      console.log(`   凭据保存至: ~/.claude/channels/wechat/credentials.json`)
      console.log('\n重启 Claude Code 会话以启用微信频道。')
      // Output JSON as last line for programmatic use
      console.log(JSON.stringify(creds))
      process.exit(0)
    }
  }

  await new Promise(r => setTimeout(r, 2000))
}

console.log('登录超时，请重新运行。')
process.exit(1)
