const SAVE_DELAY_MS = 300
export const UNSYNCED_PREFERENCES_KEY = 'gitna:unsynced-preferences'

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string }>()

function unsyncedKeys(): string[] {
  try {
    return JSON.parse(localStorage.getItem(UNSYNCED_PREFERENCES_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function setUnsyncedKeys(keys: string[]): void {
  try {
    localStorage.setItem(UNSYNCED_PREFERENCES_KEY, JSON.stringify(keys))
  } catch {
    // Storage may be unavailable; nothing local can then be overwritten.
  }
}

function send(key: string, value: string, keepalive = false): void {
  globalThis
    .fetch('api/v1/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
      keepalive,
    })
    .then((response) => {
      if (response.ok && !pending.has(key) && localStorage.getItem(key) === value)
        setUnsyncedKeys(unsyncedKeys().filter((k) => k !== key))
    })
    .catch(() => {})
}

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable; the server copy below still persists it.
  }
  const keys = unsyncedKeys()
  if (!keys.includes(key)) setUnsyncedKeys([...keys, key])
  clearTimeout(pending.get(key)?.timer)
  pending.set(key, {
    timer: setTimeout(() => {
      pending.delete(key)
      send(key, value)
    }, SAVE_DELAY_MS),
    value,
  })
}

export function flushPendingPreferences(): void {
  for (const [key, { timer, value }] of pending) {
    clearTimeout(timer)
    pending.delete(key)
    send(key, value, true)
  }
}

export function startPreferenceSync(): void {
  addEventListener('pagehide', flushPendingPreferences)
  for (const key of unsyncedKeys()) {
    const value = localStorage.getItem(key)
    if (value != null && !pending.has(key)) send(key, value)
  }
}
