import type { FileBlame, LineHistory } from '../../lib/types'

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

export function lineHistoryFromBlame(blame: FileBlame, line: number): LineHistory {
  let low = 0
  let high = blame.ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const range = blame.ranges[middle]!
    if (line < range.start) high = middle - 1
    else if (line >= range.start + range.count) low = middle + 1
    else {
      const commit = blame.commits[range.oid]
      return {
        path: blame.path,
        commitPath: range.commitPath ?? blame.path,
        line,
        generation: blame.generation,
        oid: range.oid,
        shortOid: range.oid.slice(0, 7),
        author: commit?.author,
        authoredAt: commit?.authoredAt,
        summary: commit?.summary,
        uncommitted: false,
      }
    }
  }
  return { path: blame.path, line, generation: blame.generation, uncommitted: true }
}
