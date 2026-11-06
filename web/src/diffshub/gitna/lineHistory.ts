const lineHistoryDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const lineHistoryRelative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatLineHistoryDate(value: string): string | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : lineHistoryDate.format(date)
}

export function formatLineHistoryAge(value: string, now = Date.now()): string | null {
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return null
  const elapsedMinutes = Math.round((timestamp - now) / 60_000)
  if (Math.abs(elapsedMinutes) < 60) return lineHistoryRelative.format(elapsedMinutes, 'minute')
  const elapsedHours = Math.round(elapsedMinutes / 60)
  if (Math.abs(elapsedHours) < 24) return lineHistoryRelative.format(elapsedHours, 'hour')
  const elapsedDays = Math.round(elapsedHours / 24)
  if (Math.abs(elapsedDays) < 30) return lineHistoryRelative.format(elapsedDays, 'day')
  const elapsedMonths = Math.round(elapsedDays / (365.25 / 12))
  if (Math.abs(elapsedMonths) < 12) return lineHistoryRelative.format(elapsedMonths, 'month')
  return lineHistoryRelative.format(Math.round(elapsedDays / 365.25), 'year')
}
