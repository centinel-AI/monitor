import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '../secrets'

beforeAll(() => {
  // 32 bytes, base64-encoded
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 'k').toString('base64')
})

describe('encryptSecret / decryptSecret', () => {
  it('round-trip: encrypts and decrypts back to original', () => {
    const plain = 'sk-ant-test-api-key-1234567890'
    const encrypted = encryptSecret(plain)
    const decrypted = decryptSecret(encrypted)
    expect(decrypted).toBe(plain)
  })

  it('produces different nonces on consecutive encryptions', () => {
    const plain = 'same-key'
    const enc1 = encryptSecret(plain)
    const enc2 = encryptSecret(plain)
    expect(enc1.toString('hex')).not.toBe(enc2.toString('hex'))
  })

  it('throws on tampered ciphertext (auth tag fails)', () => {
    const plain = 'my-secret'
    const encrypted = encryptSecret(plain)
    // Flip a byte in the ciphertext region (not nonce, not tag)
    const tampered = Buffer.from(encrypted)
    tampered[15] ^= 0xff
    expect(() => decryptSecret(tampered)).toThrow()
  })
})
