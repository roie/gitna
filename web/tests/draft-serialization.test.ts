import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { DraftRecord } from '../src/lib/api'

const record: DraftRecord = {
  documentId: 'worktree:unicode.txt',
  schema: 1,
  clientId: 'client',
  label: 'unicode.txt',
  path: 'unicode.txt',
  revision: 1,
  contents: '🙂é'.repeat(100),
  baselineHash: 'baseline',
  maxBytes: 100,
  updatedAt: '2026-01-01T00:00:00Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('serializes the full draft and preserves approved UTF-8 growth in the worker', async () => {
  const scope = { onmessage: (_event: MessageEvent) => {}, postMessage: vi.fn() }
  vi.stubGlobal('self', scope)
  await import('../src/lib/draftSerializationWorker')
  scope.onmessage(new MessageEvent('message', { data: { id: 7, record: { ...record } } }))
  const result = scope.postMessage.mock.calls[0]![0] as { id: number; body: Blob; maxBytes: number }
  expect(result.id).toBe(7)
  expect(result.maxBytes).toBe(new TextEncoder().encode(record.contents).length)
  expect(JSON.parse(await result.body.text())).toEqual({ ...record, maxBytes: result.maxBytes })
  expect(result.body.type).toBe('application/json')
})

it('rejects pending backups on worker failure and can start a fresh worker', async () => {
  const workers: BackupWorker[] = []
  class BackupWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() {
      workers.push(this)
    }
  }
  vi.stubGlobal('Worker', BackupWorker)
  const { serializeDraft } = await import('../src/lib/draftSerialization')
  const first = serializeDraft(record)
  const second = serializeDraft({ ...record, revision: 2 })
  const failures = Promise.all([
    expect(first).rejects.toThrow('Could not serialize draft backup'),
    expect(second).rejects.toThrow('Could not serialize draft backup'),
  ])
  workers[0]!.onerror!()
  await failures
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  const recovered = serializeDraft(record)
  expect(workers).toHaveLength(2)
  const { id } = workers[1]!.postMessage.mock.calls[0]![0] as { id: number }
  const body = new Blob(['{}'])
  workers[1]!.onmessage!(new MessageEvent('message', { data: { id, body } }))
  await expect(recovered).resolves.toEqual({ id, body })
})
