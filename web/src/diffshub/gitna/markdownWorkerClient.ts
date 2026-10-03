import type { MarkdownParseResponse, MarkdownTree } from './markdownParser'

type ParserWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>
interface Job {
  id: number
  value: string
  resolve(tree: MarkdownTree): void
  reject(error: Error): void
}

export class MarkdownWorkerClient {
  private running: Job | null = null
  private pending: Job | null = null
  private nextId = 0
  private disposed = false

  constructor(private readonly worker: ParserWorker) {
    worker.onmessage = ({ data }: MessageEvent<MarkdownParseResponse>) => {
      if (this.disposed || data.id !== this.running?.id) return
      const job = this.running
      this.running = null
      if ('error' in data) job.reject(new Error(data.error))
      else job.resolve(data.tree)
      if (this.pending != null) {
        const pending = this.pending
        this.pending = null
        this.send(pending)
      }
    }
    worker.onerror = (event) =>
      this.dispose(
        new Error(`Markdown parser worker failed.${event?.message ? ` ${event.message}` : ''}`),
      )
    worker.onmessageerror = () =>
      this.dispose(new Error('Unable to read the Markdown parser response.'))
  }

  parse(value: string): Promise<MarkdownTree> {
    if (this.disposed) return Promise.reject(new Error('Markdown parser worker is closed.'))
    // At most one running parse and one latest revision; edits cannot grow the queue.
    const superseded = new DOMException('Markdown revision superseded.', 'AbortError')
    this.running?.reject(superseded)
    this.pending?.reject(superseded)
    return new Promise((resolve, reject) => {
      const job = { id: ++this.nextId, value, resolve, reject }
      if (this.running == null) this.send(job)
      else this.pending = job
    })
  }

  dispose(error: Error = new DOMException('Markdown preview closed.', 'AbortError')): void {
    if (this.disposed) return
    this.disposed = true
    this.running?.reject(error)
    this.pending?.reject(error)
    this.running = this.pending = null
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null
    this.worker.terminate()
  }

  private send(job: Job): void {
    this.running = job
    try {
      this.worker.postMessage({ id: job.id, value: job.value })
    } catch (error) {
      this.dispose(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
