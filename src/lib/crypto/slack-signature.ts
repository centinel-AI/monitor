import { createHmac, timingSafeEqual } from 'node:crypto'

// Slack request signing (v0). Verifies inbound interactivity/event requests:
//   basestring = "v0:" + X-Slack-Request-Timestamp + ":" + rawBody
//   expected   = "v0=" + hex(HMAC_SHA256(signingSecret, basestring))
// compared timing-safe against the X-Slack-Signature header.
// Docs: https://api.slack.com/authentication/verifying-requests-from-slack

const MAX_SKEW_SECONDS = 300 // replay window: reject requests older/newer than 5 min

export interface SlackSignatureInput {
  signingSecret: string
  signature: string | null
  timestamp: string | null
  rawBody: string
  /** Injectable clock for tests; defaults to Date.now(). */
  nowMs?: number
}

/**
 * True iff the request carries a valid, non-replayed Slack signature.
 * Returns false (never throws, never leaks the secret or the computed digest)
 * on any missing/invalid input so callers can answer a generic 401.
 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  const { signingSecret, signature, timestamp, rawBody } = input
  if (!signingSecret || !signature || !timestamp) return false

  // Timestamp must be an integer count of seconds within the replay window.
  const ts = Number(timestamp)
  if (!Number.isInteger(ts)) return false
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000)
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) return false

  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`

  // Constant-time compare; bail on length mismatch without leaking via timing.
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
