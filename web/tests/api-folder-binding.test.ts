import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createApi } from '../src/lib/api'

afterEach(() => vi.unstubAllGlobals())

it('keeps requests from an old client bound to its folder after another client is created', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const source = createApi('http://127.0.0.1:1234/g/token/source/')
  const destination = createApi('http://127.0.0.1:1234/g/token/destination/')

  await destination.snapshot()
  await source.snapshot()
  await source.openFolder('/another-folder')

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'http://127.0.0.1:1234/g/token/destination/api/v1/snapshot',
    'http://127.0.0.1:1234/g/token/source/api/v1/snapshot',
    'http://127.0.0.1:1234/g/token/source/api/v1/folder',
  ])
})
