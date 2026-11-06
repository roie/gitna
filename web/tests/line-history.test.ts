import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { formatLineHistoryAge } from '../src/diffshub/gitna/lineHistory'
import { createApi } from '../src/lib/api'

const response = {
  path: 'src/a file.ts',
  line: 9,
  generation: 4,
  oid: '0123456789012345678901234567890123456789',
  shortOid: '0123456',
  author: 'Test',
  authoredAt: '2026-08-29T12:00:00Z',
  summary: 'change line',
  uncommitted: false,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('current line history', () => {
  it('requests one encoded worktree line and forwards cancellation', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(response), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()

    await expect(createApi().lineHistory('src/a file.ts', 9, controller.signal)).resolves.toEqual(
      response,
    )
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('api/v1/worktree/line-history?path=src%2Fa+file.ts&line=9')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('formats recent history without hiding the exact server timestamp', () => {
    const now = Date.parse('2026-08-29T12:30:00Z')
    expect(formatLineHistoryAge('2026-08-29T12:00:00Z', now)).toMatch(/30 minutes? ago/)
    expect(formatLineHistoryAge('2026-05-29T12:30:00Z', now)).toBe('3 months ago')
    expect(formatLineHistoryAge('2024-08-29T12:30:00Z', now)).toBe('2 years ago')
    expect(formatLineHistoryAge('2026-11-29T12:30:00Z', now)).toBe('in 3 months')
    expect(formatLineHistoryAge('not-a-date', now)).toBeNull()
  })
})
