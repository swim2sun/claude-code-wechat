/**
 * AES-128-ECB encrypt/decrypt for WeChat CDN media.
 * Zero external dependencies — uses Node.js built-in crypto.
 */
import { createCipheriv, createDecipheriv } from 'crypto'

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/**
 * Parse an AES key from the iLink API into a raw 16-byte Buffer.
 *
 * Two encodings seen in the wild:
 *   - base64(raw 16 bytes) → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * Also accepts raw hex strings (32 chars) from image_item.aeskey.
 */
export function parseAesKey(keyInput: string): Buffer {
  if (/^[0-9a-fA-F]{32}$/.test(keyInput)) {
    return Buffer.from(keyInput, 'hex')
  }

  const decoded = Buffer.from(keyInput, 'base64')
  if (decoded.length === 16) return decoded

  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }

  throw new Error(
    `invalid AES key: expected 16 raw bytes, 32 hex chars, or base64-encoded equivalent, got ${decoded.length} bytes`,
  )
}
