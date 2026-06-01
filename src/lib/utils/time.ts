import { formatDistanceToNow } from 'date-fns'
import { enUS } from 'date-fns/locale'

/**
 * Formats milliseconds into a human-readable duration string.
 * e.g. 9240000 → "2h 34m", 2700000 → "45m", 10800000 → "3h"
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 1000 / 60)
  const hours        = Math.floor(totalMinutes / 60)
  const minutes      = totalMinutes % 60

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return '< 1m'
}

/**
 * Returns the HH:MM representation of an ISO timestamp in UTC.
 * e.g. "2024-03-15T14:32:00Z" → "14:32"
 */
export function formatTime(isoString: string): string {
  const date    = new Date(isoString)
  const hours   = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Returns a relative time string in English.
 * e.g. "3 minutes ago", "about 2 hours ago"
 */
export function formatRelativeTime(isoString: string): string {
  return formatDistanceToNow(new Date(isoString), { addSuffix: true, locale: enUS })
}
