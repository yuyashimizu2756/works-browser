/** 画面表示用の書式ヘルパー。 */

const DATE_TIME = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const SHORT_DATE = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const NUMBER = new Intl.NumberFormat('ja-JP')

/** 1536 → `1.5 KB`。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** 走査日時など、秒まで見たいとき。`null` は「未走査」。 */
export function formatDate(ms: number | null): string {
  if (!ms) return '未走査'
  return DATE_TIME.format(new Date(ms))
}

/** カード用の短い日付。 */
export function formatShortDate(ms: number | null): string {
  if (!ms) return '—'
  return SHORT_DATE.format(new Date(ms))
}

export function formatCount(value: number): string {
  return NUMBER.format(value)
}

/** 動画の長さ。`83000` → `1:23`、`3725000` → `1:02:05`、null → `—`。 */
export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

export function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}
