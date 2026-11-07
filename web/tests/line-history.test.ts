import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { formatLineHistoryAge, lineHistoryFromBlame } from '../src/diffshub/gitna/lineHistory'
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

  it('sends an approved large-file budget', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(response), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)

    await createApi().lineHistory('big.txt', 3, undefined, 2_000_000)
    expect(fetch.mock.calls[0]![0]).toBe(
      'api/v1/worktree/line-history?path=big.txt&line=3&maxBytes=2000000',
    )
  })

  it('requests whole-file blame with an approved budget', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ path: 'a b.ts', generation: 1, commits: {}, ranges: [] }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetch)

    await createApi().fileBlame!('a b.ts', undefined, 2_000_000)
    expect(fetch.mock.calls[0]![0]).toBe('api/v1/worktree/blame?path=a+b.ts&maxBytes=2000000')
  })

  it('looks up every line from whole-file blame ranges', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const blame = {
      path: 'src/new.ts',
      generation: 4,
      commits: {
        [a]: { author: 'Ann', authoredAt: '2026-08-29T12:00:00Z', summary: 'first' },
        [b]: { author: 'Bo', summary: 'second' },
      },
      ranges: [
        { start: 2, count: 2, oid: a, commitPath: 'src/old.ts' },
        { start: 6, count: 1, oid: b },
      ],
    }
    const at = (line: number) => lineHistoryFromBlame(blame, line)
    expect([1, 4, 5, 7].map((line) => at(line).uncommitted)).toEqual([true, true, true, true])
    expect(at(3)).toEqual({
      path: 'src/new.ts',
      commitPath: 'src/old.ts',
      line: 3,
      generation: 4,
      oid: a,
      shortOid: 'aaaaaaa',
      author: 'Ann',
      authoredAt: '2026-08-29T12:00:00Z',
      summary: 'first',
      uncommitted: false,
    })
    expect(at(6)).toMatchObject({ commitPath: 'src/new.ts', author: 'Bo', uncommitted: false })
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
