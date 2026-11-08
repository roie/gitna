import type { DraftRecord } from './api'

interface SerializedDraft {
  body: Blob
  maxBytes?: number
}

let worker: Worker | undefined
let sequence = 0
const pending = new Map<
  number,
  { resolve: (draft: SerializedDraft) => void; reject: (error: Error) => void }
>()

export function serializeDraft(record: DraftRecord): Promise<SerializedDraft> {
  if (worker == null) {
    worker = new Worker(new URL('./draftSerializationWorker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<SerializedDraft & { id: number }>) => {
      const request = pending.get(event.data.id)
      pending.delete(event.data.id)
      request?.resolve(event.data)
    }
    worker.onerror = () => {
      worker?.terminate()
      worker = undefined
      for (const request of pending.values())
        request.reject(new Error('Could not serialize draft backup'))
      pending.clear()
    }
  }
  const id = ++sequence
  const activeWorker = worker
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    activeWorker.postMessage({ id, record })
  })
}
