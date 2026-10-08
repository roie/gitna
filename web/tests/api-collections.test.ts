import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApi } from '../src/lib/api'

afterEach(() => vi.unstubAllGlobals())

for (const method of ['tags', 'stashes'] as const) {
  describe(method, () => {
    it.each([null, []])('returns an empty collection for %j', async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body))),
      )
      expect(await createApi('http://localhost/')[method]()).toEqual([])
    })
    it('preserves entries', async () => {
      const entries =
        method === 'tags' ? [{ name: 'v1', oid: 'abc' }] : [{ ref: 'stash@{0}', oid: 'abc' }]
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(entries))),
      )
      expect(await createApi('http://localhost/')[method]()).toEqual(entries)
    })
    it.each([{}, 'invalid', 42])('rejects malformed collections %j', async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body))),
      )
      await expect(createApi('http://localhost/')[method]()).rejects.toThrow('Expected an array')
    })
    it('does not turn request failures into empty results', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{"error":"failed"}', { status: 500 })),
      )
      await expect(createApi('http://localhost/')[method]()).rejects.toThrow()
    })
  })
}
