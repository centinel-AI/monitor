// Simple in-memory rate limiter for server-side use.
// For multi-instance deployments, replace with Redis-backed solution.

const requests = new Map<string, number[]>()

export function rateLimit(
  identifier: string,
  limit   = 100,
  windowMs = 60_000,
): { allowed: boolean; remaining: number } {
  const now         = Date.now()
  const windowStart = now - windowMs

  const timestamps = (requests.get(identifier) ?? []).filter((t) => t > windowStart)

  if (timestamps.length >= limit) {
    return { allowed: false, remaining: 0 }
  }

  timestamps.push(now)
  requests.set(identifier, timestamps)

  return { allowed: true, remaining: limit - timestamps.length }
}
