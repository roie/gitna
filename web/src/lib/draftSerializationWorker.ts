import type { DraftRecord } from './api'

self.onmessage = (event: MessageEvent<{ id: number; record: DraftRecord }>) => {
  const { id, record } = event.data
  if (record.maxBytes != null) {
    record.maxBytes = Math.max(record.maxBytes, new TextEncoder().encode(record.contents).length)
  }
  const body = new Blob([JSON.stringify(record)], { type: 'application/json' })
  self.postMessage({ id, body, maxBytes: record.maxBytes })
}
