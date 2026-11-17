import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { savePreference } from '../src/lib/preferences'

const fetchMock = vi.fn()
const storage = new Map<string, string>()

beforeEach(() => {
  vi.useFakeTimers()
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  })
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('writes localStorage synchronously', () => {
  savePreference('theme', 'dark')
  expect(localStorage.getItem('theme')).toBe('dark')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('sends one request with the last value for repeated writes of one key', async () => {
  for (let i = 0; i < 10; i++) savePreference('gitna-source-control-pane-sizes-v2', String(i))
  await vi.advanceTimersByTimeAsync(300)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('api/v1/preferences')
  expect(init.method).toBe('PUT')
  expect(JSON.parse(init.body as string)).toEqual({
    key: 'gitna-source-control-pane-sizes-v2',
    value: '9',
  })
})

it('sends one request per key', async () => {
  savePreference('theme', 'dark')
  savePreference('gitna:inline-blame', 'false')
  await vi.advanceTimersByTimeAsync(300)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('ignores a rejected request', async () => {
  fetchMock.mockRejectedValue(new Error('offline'))
  savePreference('theme', 'dark')
  await vi.advanceTimersByTimeAsync(300)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
