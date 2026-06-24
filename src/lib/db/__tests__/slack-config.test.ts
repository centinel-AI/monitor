import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/client', () => ({ query: vi.fn() }))
vi.mock('@/lib/crypto/secrets', () => ({
  encryptSecret: vi.fn(() => Buffer.from('ENCRYPTED')),
  decryptSecret: vi.fn(() => 'xoxb-decrypted-token'),
}))

import { query } from '@/lib/db/client'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { getProjectSlackConfig, getProjectSlackStatus, setProjectSlackConfig } from '../queries'

const mockQuery = vi.mocked(query)
const PID = '12345678-1234-1234-1234-123456789012'

beforeEach(() => vi.clearAllMocks())

describe('setProjectSlackConfig', () => {
  it('encrypts the bot token and stores channel + ciphertext scoped to the project', async () => {
    mockQuery.mockResolvedValue([])
    await setProjectSlackConfig(PID, { channel: '#ops', botToken: 'xoxb-real-secret' })

    expect(encryptSecret).toHaveBeenCalledWith('xoxb-real-secret')
    // 1st query ensures the row, 2nd writes channel + encrypted token.
    const update = mockQuery.mock.calls[1]
    expect(String(update[0])).toContain('slack_bot_token_encrypted')
    expect(update[1]).toEqual(['#ops', Buffer.from('ENCRYPTED'), PID])
    // plaintext token never goes into the SQL params
    expect(JSON.stringify(update[1])).not.toContain('xoxb-real-secret')
  })
})

describe('getProjectSlackStatus', () => {
  it('reports configured + channel WITHOUT exposing any token', async () => {
    mockQuery.mockResolvedValue([{ slack_channel: '#ops', slack_bot_token_encrypted: Buffer.from('ENCRYPTED') }])
    const status = await getProjectSlackStatus(PID)
    expect(status).toEqual({ slackConfigured: true, channel: '#ops' })
    expect(Object.keys(status)).not.toContain('botToken')
  })

  it('reports not configured when no row / no token', async () => {
    mockQuery.mockResolvedValue([])
    expect(await getProjectSlackStatus(PID)).toEqual({ slackConfigured: false, channel: null })
  })
})

describe('getProjectSlackConfig', () => {
  it('decrypts the stored token for server-side use', async () => {
    mockQuery.mockResolvedValue([{ slack_channel: '#ops', slack_bot_token_encrypted: Buffer.from('ENCRYPTED') }])
    const cfg = await getProjectSlackConfig(PID)
    expect(decryptSecret).toHaveBeenCalled()
    expect(cfg).toEqual({ channel: '#ops', botToken: 'xoxb-decrypted-token' })
  })

  it('returns nulls when not configured', async () => {
    mockQuery.mockResolvedValue([])
    expect(await getProjectSlackConfig(PID)).toEqual({ channel: null, botToken: null })
  })
})
