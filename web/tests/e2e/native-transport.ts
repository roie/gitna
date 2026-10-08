/// <reference types="node" />

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { URL } from 'node:url'

interface HeldRequest {
  release: () => void
  requested: Promise<void>
  markRequested: () => void
  gate: Promise<void>
}

/**
 * A loopback forwarder for browser acceptance of the native EventSource path.
 * It forwards the real capability route and owns the response/socket so tests
 * can sever an already-open stream instead of fabricating browser events.
 */
export class NativeTransportProxy {
  private readonly upstream: URL
  private readonly server: Server
  private readonly activeStreams = new Set<ServerResponse>()
  private listeningOrigin: string | null = null
  private outage = false
  private snapshotFailure: { status: number; body: string } | null = null
  private snapshotGate: HeldRequest | null = null
  private fileCountGate: HeldRequest | null = null
  private fileCountFailure: { status: number; body: string } | null = null
  private directoryFailure: { status: number; body: string } | null = null
  private mutationCount = 0
  private readCount = 0
  private readonly gitReadRequestPaths: string[] = []
  private activeReads = 0
  private maxConcurrentReads = 0

  constructor(upstreamUrl: string) {
    this.upstream = new URL(upstreamUrl)
    this.server = createServer((incoming, outgoing) => {
      void this.forward(incoming, outgoing)
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        const address = this.server.address()
        if (address == null || typeof address === 'string') {
          reject(new Error('native transport proxy did not expose a TCP address'))
          return
        }
        this.listeningOrigin = `http://127.0.0.1:${address.port}`
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(0, '127.0.0.1')
    })
  }

  urlFor(upstreamUrl: string | URL = this.upstream): string {
    if (this.listeningOrigin == null) throw new Error('native transport proxy is not started')
    const target = typeof upstreamUrl === 'string' ? new URL(upstreamUrl) : upstreamUrl
    return `${this.listeningOrigin}${target.pathname}${target.search}`
  }

  get activeStreamCount(): number {
    return this.activeStreams.size
  }

  get reads(): number {
    return this.readCount
  }

  get mutations(): number {
    return this.mutationCount
  }

  get maxConcurrentReadCount(): number {
    return this.maxConcurrentReads
  }

  get gitReadPaths(): readonly string[] {
    return this.gitReadRequestPaths
  }

  async waitForStream(timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout
    while (this.activeStreams.size === 0) {
      if (Date.now() >= deadline)
        throw new Error('native EventSource did not connect through proxy')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** Sever each browser-owned active SSE response and reject reconnects. */
  setOutage(value: boolean): void {
    this.outage = value
    if (!value) return
    for (const stream of this.activeStreams) stream.destroy()
  }

  /** Fail Snapshot reads until recovery is explicitly enabled. */
  failSnapshots(status: 403 | 404, error: string): void {
    this.snapshotFailure = { status, body: JSON.stringify({ error }) }
  }

  clearSnapshotFailure(): void {
    this.snapshotFailure = null
  }

  /** Hold one authoritative repository file-count response until release(). */
  holdNextFileCount(): HeldRequest {
    if (this.fileCountGate != null) throw new Error('a file-count gate is already installed')
    const held = this.createGate()
    this.fileCountGate = held
    return held
  }

  /** Make the next authoritative repository file-count response fail. */
  failNextFileCount(status: 500 | 503, error: string): void {
    this.fileCountFailure = { status, body: JSON.stringify({ error }) }
  }

  /** Make the next authoritative directory response fail. */
  failNextDirectory(status: 500 | 503, error: string): void {
    this.directoryFailure = { status, body: JSON.stringify({ error }) }
  }

  /** Hold one forwarded Snapshot until release() is called. */
  holdNextSnapshot(): HeldRequest {
    if (this.snapshotGate != null) throw new Error('a Snapshot gate is already installed')
    const held = this.createGate()
    this.snapshotGate = held
    return held
  }

  async close(): Promise<void> {
    this.outage = true
    for (const stream of this.activeStreams) stream.destroy()
    this.snapshotGate?.release()
    this.fileCountGate?.release()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private isSnapshot(pathname: string): boolean {
    return pathname.endsWith('/api/v1/snapshot')
  }

  private isFileCount(pathname: string): boolean {
    return pathname.endsWith('/api/v1/files/count')
  }

  private isDirectory(pathname: string): boolean {
    return pathname.endsWith('/api/v1/directory')
  }

  private isEvents(pathname: string): boolean {
    return pathname.endsWith('/api/v1/events')
  }

  private createGate(): HeldRequest {
    let release!: () => void
    let markRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { release, requested, markRequested, gate }
  }

  private isRead(request: IncomingMessage): boolean {
    return request.method === 'GET' || request.method === 'HEAD'
  }

  private async forward(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const target = new URL(incoming.url ?? '/', this.upstream)
    const events = this.isEvents(target.pathname)
    const snapshot = this.isSnapshot(target.pathname)
    const fileCount = this.isFileCount(target.pathname)
    const directory = this.isDirectory(target.pathname)
    const read = this.isRead(incoming)
    if (read) {
      this.readCount += 1
      if (/\/api\/v1\/(?:graph|branches|stashes|tags|conflicts)(?:\/|\?|$)/.test(target.pathname)) {
        this.gitReadRequestPaths.push(target.pathname)
      }
      this.activeReads += 1
      this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads)
    } else {
      this.mutationCount += 1
    }

    try {
      if (this.outage && (events || read)) {
        outgoing.writeHead(503, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: 'transport outage (test)' }))
        return
      }
      if (snapshot && this.snapshotFailure != null) {
        const failure = this.snapshotFailure
        outgoing.writeHead(failure.status, { 'content-type': 'application/json' })
        outgoing.end(failure.body)
        return
      }
      if (fileCount && this.fileCountFailure != null) {
        const failure = this.fileCountFailure
        this.fileCountFailure = null
        outgoing.writeHead(failure.status, { 'content-type': 'application/json' })
        outgoing.end(failure.body)
        return
      }
      if (directory && this.directoryFailure != null) {
        const failure = this.directoryFailure
        this.directoryFailure = null
        outgoing.writeHead(failure.status, { 'content-type': 'application/json' })
        outgoing.end(failure.body)
        return
      }
      if (snapshot && this.snapshotGate != null) {
        const gate = this.snapshotGate
        // Keep ownership until the gate completes. close() can then release a
        // request that is still held when a test fails or the browser exits.
        gate.markRequested()
        await gate.gate
        if (this.snapshotGate === gate) this.snapshotGate = null
      }
      if (fileCount && this.fileCountGate != null) {
        const gate = this.fileCountGate
        gate.markRequested()
        await gate.gate
        if (this.fileCountGate === gate) this.fileCountGate = null
      }
      await this.forwardUpstream(incoming, outgoing, target, events)
    } finally {
      if (read) this.activeReads -= 1
    }
  }

  private forwardUpstream(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    target: URL,
    events: boolean,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const headers = { ...incoming.headers }
      headers.host = this.upstream.host
      headers.origin = this.upstream.origin
      delete headers['x-forwarded-host']
      delete headers['x-forwarded-origin']
      const upstreamRequest = httpRequest(
        {
          protocol: this.upstream.protocol,
          hostname: this.upstream.hostname,
          port: this.upstream.port,
          method: incoming.method,
          path: `${target.pathname}${target.search}`,
          headers,
        },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers }
          delete responseHeaders.connection
          outgoing.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
          if (events) {
            this.activeStreams.add(outgoing)
            const remove = () => this.activeStreams.delete(outgoing)
            outgoing.once('close', remove)
            upstreamResponse.once('close', remove)
          }
          upstreamResponse.pipe(outgoing)
          upstreamResponse.once('end', resolve)
          upstreamResponse.once('error', resolve)
        },
      )
      upstreamRequest.once('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502)
        outgoing.end()
        resolve()
      })
      incoming.pipe(upstreamRequest)
      outgoing.once('close', () => upstreamRequest.destroy())
    })
  }
}
