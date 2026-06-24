import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/db/queries', () => ({ getProjectSlackConfig: vi.fn() }))

import { getProjectSlackConfig } from '@/lib/db/queries'
import { getSlackConfigForProject } from '../client'

const mockGetConfig = vi.mocked(getProjectSlackConfig)
const PID = '12345678-1234-1234-1234-123456789012'
const ENV_BACKUP = { token: process.env.SLACK_BOT_TOKEN, channel: process.env.SLACK_CHANNEL }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.SLACK_BOT_TOKEN
  delete process.env.SLACK_CHANNEL
})
afterEach(() => {
  process.env.SLACK_BOT_TOKEN = ENV_BACKUP.token
  process.env.SLACK_CHANNEL = ENV_BACKUP.channel
})

describe('getSlackConfigForProject — single source = project_settings', () => {
  it('reads the notifier config from project_settings (getProjectSlackConfig), not projects.*', async () => {
    mockGetConfig.mockResolvedValue({ channel: '#ops', botToken: 'xoxb-from-project-settings' })
    const cfg = await getSlackConfigForProject(PID)
    expect(mockGetConfig).toHaveBeenCalledWith(PID)
    expect(cfg).toEqual({ channel: '#ops', botToken: 'xoxb-from-project-settings' })
  })

  it('falls back to global envs when the project has no config', async () => {
    mockGetConfig.mockResolvedValue({ channel: null, botToken: null })
    process.env.SLACK_BOT_TOKEN = 'xoxb-env'
    process.env.SLACK_CHANNEL = '#global'
    expect(await getSlackConfigForProject(PID)).toEqual({ channel: '#global', botToken: 'xoxb-env' })
  })

  it('returns null when neither project_settings nor envs provide a usable config', async () => {
    mockGetConfig.mockResolvedValue({ channel: null, botToken: null })
    expect(await getSlackConfigForProject(PID)).toBeNull()
  })
})
