const SAVE_DELAY_MS = 300

const pending = new Map<string, ReturnType<typeof setTimeout>>()

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable; the server copy below still persists it.
  }
  clearTimeout(pending.get(key))
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      globalThis
        .fetch('api/v1/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        })
        .catch(() => {})
    }, SAVE_DELAY_MS),
  )
}
