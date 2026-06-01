import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function getMasterKey(): Buffer {
  const key = process.env.MASTER_ENCRYPTION_KEY
  if (!key) throw new Error('MASTER_ENCRYPTION_KEY is not set')
  const buf = Buffer.from(key, 'base64')
  if (buf.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must decode to 32 bytes (base64-encoded)')
  }
  return buf
}

export function encryptSecret(plaintext: string): Buffer {
  const masterKey = getMasterKey()
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, ciphertext, tag])
}

export function decryptSecret(encrypted: Buffer): string {
  if (encrypted.length < 28) throw new Error('Encrypted buffer too short')
  const masterKey = getMasterKey()
  const nonce = encrypted.subarray(0, 12)
  const tag = encrypted.subarray(encrypted.length - 16)
  const ciphertext = encrypted.subarray(12, encrypted.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
