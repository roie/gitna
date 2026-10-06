import { describe, expect, it, vi } from 'vite-plus/test'
import { MarkdownWorkerClient } from './markdownWorkerClient'
import { parseMarkdown, type MarkdownParseResponse } from './markdownParser'

class FakeWorker {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  onmessageerror: Worker['onmessageerror'] = null
  postMessage = vi.fn()
  terminate = vi.fn()
  respond(data: MarkdownParseResponse) {
    this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent)
  }
}

function setup() {
  const worker = new FakeWorker()
  return { worker, client: new MarkdownWorkerClient(worker) }
}

describe('Markdown worker lifecycle', () => {
  it('coalesces rapid edits, ignores unknown responses, and returns only the latest revision', async () => {
    const { worker, client } = setup()
    const first = client.parse('first').catch((e: Error) => e.name)
    const skipped = client.parse('skipped').catch((e: Error) => e.name)
    const latest = client.parse('latest')
    expect(worker.postMessage.mock.calls).toEqual([[{ id: 1, value: 'first' }]])
    expect(await first).toBe('AbortError')
    expect(await skipped).toBe('AbortError')
    worker.respond({ id: 999, tree: parseMarkdown('wrong') })
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    worker.respond({ id: 1, tree: parseMarkdown('first') })
    expect(worker.postMessage.mock.calls[1]).toEqual([{ id: 3, value: 'latest' }])
    const tree = parseMarkdown('latest')
    worker.respond({ id: 3, tree })
    expect(await latest).toBe(tree)
    client.dispose()
  })

  it('terminates running and queued work when hidden or unmounted', async () => {
    const { worker, client } = setup()
    const first = client.parse('first').catch((e: Error) => e.name)
    const second = client.parse('second').catch((e: Error) => e.name)
    client.dispose()
    client.dispose()
    expect(await first).toBe('AbortError')
    expect(await second).toBe('AbortError')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.onmessage).toBeNull()
    await expect(client.parse('closed')).rejects.toThrow('closed')
  })

  it('reports parse failures without falling back to main-thread parsing', async () => {
    const { worker, client } = setup()
    const pending = client.parse('bad')
    worker.respond({ id: 1, error: 'parse failed' })
    await expect(pending).rejects.toThrow('parse failed')
    client.dispose()
  })

  it.each(['onerror', 'onmessageerror'] as const)(
    'reports %s and releases the worker',
    async (event) => {
      const { worker, client } = setup()
      const pending = client.parse('first')
      const handler = worker[event] as () => void
      handler()
      await expect(pending).rejects.toThrow(/worker failed|parser response/)
      expect(worker.terminate).toHaveBeenCalledTimes(1)
    },
  )

  it('reports postMessage failures and releases the worker', async () => {
    const { worker, client } = setup()
    worker.postMessage.mockImplementation(() => {
      throw new Error('transfer failed')
    })
    await expect(client.parse('first')).rejects.toThrow('transfer failed')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
