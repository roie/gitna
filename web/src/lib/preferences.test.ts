import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import {
  flushPendingPreferences,
  savePreference,
  startPreferenceSync,
  UNSYNCED_PREFERENCES_KEY,
} from './preferences'

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

const unsynced = () => JSON.parse(storage.get(UNSYNCED_PREFERENCES_KEY) ?? '[]') as string[]
const sent = (call: number) => {
  const init = fetchMock.mock.calls[call][1] as RequestInit
  return { ...(JSON.parse(init.body as string) as object), keepalive: init.keepalive }
}

it('keeps a preference unsynced until the server accepts it', async () => {
  savePreference('theme', 'dark')
  expect(unsynced()).toEqual(['theme'])
  await vi.advanceTimersByTimeAsync(300)
  expect(unsynced()).toEqual([])
})

it('keeps a preference unsynced when its save fails, and resends it on the next load', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'))
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
  savePreference('theme', 'dark')
  await vi.advanceTimersByTimeAsync(300)
  savePreference('gitna:inline-blame', 'false')
  await vi.advanceTimersByTimeAsync(300)
  expect(unsynced()).toEqual(['theme', 'gitna:inline-blame'])

  vi.stubGlobal('addEventListener', vi.fn())
  startPreferenceSync()
  await vi.advanceTimersByTimeAsync(0)
  expect([sent(2), sent(3)]).toEqual([
    { key: 'theme', value: 'dark', keepalive: false },
    { key: 'gitna:inline-blame', value: 'false', keepalive: false },
  ])
  expect(unsynced()).toEqual([])
})

it('keeps a toggled preference unsynced when an older value is acknowledged', async () => {
  let acknowledge: (response: Response) => void = () => {}
  fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (acknowledge = resolve)))
  savePreference('gitna:conversations', 'false')
  await vi.advanceTimersByTimeAsync(300)
  savePreference('gitna:conversations', 'true')
  acknowledge(new Response(null, { status: 204 }))
  await vi.advanceTimersByTimeAsync(0)
  expect(unsynced()).toEqual(['gitna:conversations'])
  await vi.advanceTimersByTimeAsync(300)
  expect(sent(1)).toEqual({ key: 'gitna:conversations', value: 'true', keepalive: false })
  expect(unsynced()).toEqual([])
})

it('sends pending saves with keepalive when the page is hidden', async () => {
  const listen = vi.fn()
  vi.stubGlobal('addEventListener', listen)
  startPreferenceSync()
  expect(listen).toHaveBeenCalledWith('pagehide', flushPendingPreferences)

  savePreference('theme', 'dark')
  flushPendingPreferences()
  expect(sent(0)).toEqual({ key: 'theme', value: 'dark', keepalive: true })
  await vi.advanceTimersByTimeAsync(300)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(unsynced()).toEqual([])
})
