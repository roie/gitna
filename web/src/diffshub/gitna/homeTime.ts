export interface OpenedAtLabel {
  exact: string
  relative: string
}

const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

function calendarDay(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / dayMs
}

export function formatOpenedAt(
  value: string,
  now = new Date(),
  locales?: string | string[],
): OpenedAtLabel | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return null

  const exact = new Intl.DateTimeFormat(locales, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
  const elapsed = Math.max(0, now.getTime() - date.getTime())
  const relativeTime = new Intl.RelativeTimeFormat(locales, {
    numeric: 'always',
    style: 'long',
  })

  if (elapsed < minuteMs) return { exact, relative: 'Just now' }
  if (elapsed < hourMs) {
    return { exact, relative: relativeTime.format(-Math.floor(elapsed / minuteMs), 'minute') }
  }

  const elapsedCalendarDays = calendarDay(now) - calendarDay(date)
  if (elapsedCalendarDays <= 0) {
    return { exact, relative: relativeTime.format(-Math.floor(elapsed / hourMs), 'hour') }
  }
  if (elapsedCalendarDays === 1) return { exact, relative: 'Yesterday' }
  if (elapsedCalendarDays < 7) {
    return { exact, relative: relativeTime.format(-elapsedCalendarDays, 'day') }
  }

  return {
    exact,
    relative: new Intl.DateTimeFormat(locales, { dateStyle: 'medium' }).format(date),
  }
}
