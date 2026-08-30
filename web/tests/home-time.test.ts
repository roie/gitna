import { describe, expect, it } from 'vitest'

import { formatOpenedAt } from '../src/diffshub/gitna/homeTime'

const now = new Date(2026, 7, 29, 12, 0, 0)

function openedAt(value: Date) {
  return formatOpenedAt(value.toISOString(), now, 'en-US')
}

describe('formatOpenedAt', () => {
  it('describes recent openings with deterministic relative labels', () => {
    expect(openedAt(new Date(now.getTime() - 20_000))?.relative).toBe('Just now')
    expect(openedAt(new Date(now.getTime() - 2 * 60_000))?.relative).toBe('2 minutes ago')
    expect(openedAt(new Date(now.getTime() - 3 * 60 * 60_000))?.relative).toBe('3 hours ago')
    expect(openedAt(new Date(2026, 7, 28, 16, 0, 0))?.relative).toBe('Yesterday')
    expect(openedAt(new Date(2026, 7, 26, 12, 0, 0))?.relative).toBe('3 days ago')
  })

  it('uses a locale date for older openings and retains the exact date and time', () => {
    const date = new Date(2026, 7, 20, 9, 30, 0)
    const label = openedAt(date)
    expect(label).toEqual({
      exact: new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date),
      relative: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date),
    })
  })

  it('rejects invalid timestamps and treats small clock skew as just opened', () => {
    expect(formatOpenedAt('not-a-date', now, 'en-US')).toBeNull()
    expect(openedAt(new Date(now.getTime() + 60_000))?.relative).toBe('Just now')
  })
})
