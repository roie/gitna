export interface Participant {
  id: string
  kind: 'human' | 'agent'
  name: string
}

export type ConversationSource = 'worktree' | 'index' | 'commit'
export type ConversationSide = 'additions' | 'deletions'

/** The content one side of a code view shows; revision names a commit. */
export interface ConversationContent {
  source: ConversationSource
  revision?: string
}

/** What a code view shows. Files and their diffs have no deletions content
 * when that side is not a commit, the index, or a worktree file. */
export interface ConversationSurface {
  view: 'file' | 'worktree' | 'index' | 'commit' | 'comparison'
  additions: ConversationContent
  deletions?: ConversationContent
}

export interface ConversationAnchor extends ConversationContent {
  path: string
  view: ConversationSurface['view']
  /** The commit on the opposite side of the diff, when it is one. */
  against?: string
  side: ConversationSide
  startLine: number
  endLine: number
  /** Omitted when Gitna should read the lines from the anchored content. */
  code?: string
  before?: string
  after?: string
}

export interface ConversationLocation {
  path: string
  startLine: number
  endLine: number
  status: 'current' | 'moved' | 'outdated' | 'missing'
}

export interface ConversationMessage {
  id: string
  conversationId: string
  seq: number
  author: Participant
  body: string
  createdAt: string
}

export interface Conversation {
  id: string
  anchor: ConversationAnchor & { code: string }
  path: string
  location?: ConversationLocation
  status: 'open' | 'resolved'
  createdBy: Participant
  createdAt: string
  updatedAt: string
  seq: number
  messages: ConversationMessage[]
}

export interface ConversationEvent {
  seq: number
  type: string
  conversationId: string
  actor: Participant
  path?: string
}

export interface ConversationList {
  participant: Participant
  conversations: Conversation[]
  seq: number
  /** How far this participant has read each conversation. */
  read: Record<string, number>
}

export interface ConversationsApi {
  list(path: string, signal?: AbortSignal): Promise<ConversationList>
  create(anchor: ConversationAnchor, body: string, id: string): Promise<Conversation>
  reply(conversationId: string, body: string, id: string): Promise<ConversationMessage>
  setStatus(conversationId: string, status: 'open' | 'resolved'): Promise<Conversation>
  setDeleted(conversationId: string, deleted: boolean): Promise<Conversation>
  markRead(conversationId: string, seq: number): Promise<number>
  subscribe(after: number, onEvent: (event: ConversationEvent) => void): () => void
}

type Fetch = (url: string, options?: RequestInit) => Promise<Response>

export function newConversationID(prefix: 'c' | 'm'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function createConversationsApi(
  fetch: Fetch,
  expectOK: (response: Response) => Promise<Response>,
  baseURL?: string,
): ConversationsApi {
  const post = async <T>(url: string, body: unknown): Promise<T> => {
    const response = await expectOK(
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }),
    )
    return (await response.json()) as T
  }
  return {
    async list(path, signal) {
      const response = await expectOK(
        await fetch(`api/v1/conversations?path=${encodeURIComponent(path)}`, { signal }),
      )
      return (await response.json()) as ConversationList
    },
    create: (anchor, body, id) => post('api/v1/conversations', { id, anchor, body }),
    reply: (conversationId, body, id) =>
      post(`api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, { id, body }),
    setStatus: (conversationId, status) =>
      post(
        `api/v1/conversations/${encodeURIComponent(conversationId)}/${status === 'resolved' ? 'resolve' : 'reopen'}`,
        {},
      ),
    setDeleted: (conversationId, deleted) =>
      post(
        `api/v1/conversations/${encodeURIComponent(conversationId)}/${deleted ? 'delete' : 'restore'}`,
        {},
      ),
    async markRead(conversationId, seq) {
      const url = `api/v1/conversations/${encodeURIComponent(conversationId)}/read`
      return (await post<{ seq: number }>(url, { seq })).seq
    },
    subscribe(after, onEvent) {
      let source: EventSource
      let retry: ReturnType<typeof setTimeout> | undefined
      const connect = () => {
        const relative = `api/v1/conversations/events?after=${String(after)}`
        source = new EventSource(baseURL == null ? relative : new URL(relative, baseURL).href)
        source.addEventListener('conversation', (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as ConversationEvent
          after = Math.max(after, event.seq)
          onEvent(event)
        })
        // EventSource resumes a dropped stream by itself, but gives up for
        // good when the server answers with an error, as during a restart.
        source.addEventListener('error', () => {
          if (source.readyState !== EventSource.CLOSED) return
          retry = setTimeout(connect, 2000)
        })
      }
      connect()
      return () => {
        clearTimeout(retry)
        source.close()
      }
    },
  }
}

function contentKey(content: ConversationContent, path: string): string {
  return `${content.source}:${content.source === 'commit' ? (content.revision ?? '') : ''}:${path}`
}

/** Captures the selected lines and up to three lines around them. */
export function captureLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): Pick<ConversationAnchor, 'code' | 'before' | 'after'> {
  const text = (from: number, to: number) =>
    lines
      .slice(Math.max(from, 0), to)
      .map((line) => line.replace(/[\r\n]+$/, ''))
      .join('\n')
  return {
    code: text(startLine - 1, endLine),
    before: text(startLine - 4, startLine - 1),
    after: text(endLine, endLine + 3),
  }
}

/**
 * All conversations of the open folder, kept live by the event stream.
 * Components subscribe and read snapshots by the content a view shows.
 */
export class ConversationsModel {
  private byContent = new Map<string, Conversation[]>()
  private all: readonly Conversation[] = []
  participant: Participant | null = null
  private readonly listeners = new Set<() => void>()
  private readonly expanded = new Map<string, boolean>()
  private controller: AbortController | null = null
  private reload: ReturnType<typeof setTimeout> | null = null
  private stop: (() => void) | null = null
  private seq = 0
  private readonly unconfirmed = new Map<string, string>()
  private read: Record<string, number> = {}
  version = 0
  error: string | null = null

  constructor(readonly api: ConversationsApi) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(content: ConversationContent, path: string): readonly Conversation[] {
    return this.byContent.get(contentKey(content, path)) ?? []
  }

  list(): readonly Conversation[] {
    return this.all
  }

  find(id: string): Conversation | undefined {
    return this.all.find((conversation) => conversation.id === id)
  }

  isExpanded(conversation: Conversation): boolean {
    return this.expanded.get(conversation.id) ?? conversation.status === 'open'
  }

  setExpanded(id: string, expanded: boolean): void {
    this.expanded.set(id, expanded)
    this.emit()
  }

  async load(): Promise<void> {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    try {
      const list = await this.api.list('', controller.signal)
      const byContent = new Map<string, Conversation[]>()
      for (const conversation of list.conversations) {
        const key = contentKey(
          conversation.anchor,
          conversation.location?.path ?? conversation.path,
        )
        byContent.set(key, [...(byContent.get(key) ?? []), conversation])
      }
      this.byContent = byContent
      this.all = list.conversations
      this.participant = list.participant
      for (const [id, seq] of Object.entries(list.read)) {
        this.read[id] = Math.max(this.read[id] ?? 0, seq)
      }
      this.error = null
      if (this.stop == null) {
        this.seq = list.seq
        this.stop = this.api.subscribe(list.seq, (event) => this.receive(event))
      }
    } catch (error) {
      if (controller.signal.aborted) return
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.emit()
  }

  async create(anchor: ConversationAnchor, body: string): Promise<Conversation> {
    const conversation = await this.retrying(JSON.stringify([anchor, body]), 'c', (id) =>
      this.api.create(anchor, body, id),
    )
    this.expanded.set(conversation.id, true)
    await this.load()
    return conversation
  }

  async reply(conversation: Conversation, body: string): Promise<void> {
    await this.retrying(JSON.stringify([conversation.id, body]), 'm', (id) =>
      this.api.reply(conversation.id, body, id),
    )
    await this.load()
  }

  /**
   * Resubmitting the same text after a failure reuses its id, so a write
   * whose response was lost is not stored twice.
   */
  private async retrying<T>(key: string, prefix: 'c' | 'm', write: (id: string) => Promise<T>) {
    const id = this.unconfirmed.get(key) ?? newConversationID(prefix)
    this.unconfirmed.set(key, id)
    const result = await write(id)
    this.unconfirmed.delete(key)
    return result
  }

  async setStatus(conversation: Conversation, status: 'open' | 'resolved'): Promise<void> {
    await this.attempt(async () => {
      await this.api.setStatus(conversation.id, status)
      this.expanded.set(conversation.id, status === 'open')
    })
  }

  /** The conversation this tab deleted last, until it is restored or dismissed. */
  recentlyDeleted: Conversation | null = null

  async setDeleted(conversation: Conversation, deleted: boolean): Promise<void> {
    await this.attempt(async () => {
      await this.api.setDeleted(conversation.id, deleted)
      this.recentlyDeleted = deleted ? conversation : null
      if (deleted) {
        setTimeout(() => {
          if (this.recentlyDeleted === conversation) this.dismissDeleted()
        }, 8000)
      }
    })
  }

  reportError(message: string): void {
    this.error = message
    this.emit()
  }

  dismissError(): void {
    this.error = null
    this.emit()
  }

  private async attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
      return
    }
    await this.load()
  }

  dismissDeleted(): void {
    this.recentlyDeleted = null
    this.emit()
  }

  async markRead(conversation: Conversation): Promise<void> {
    if (!this.unread(conversation)) return
    this.read[conversation.id] = await this.api.markRead(conversation.id, conversation.seq)
    this.emit()
  }

  /** Whether someone else wrote in conversation since this participant last read it. */
  unread(conversation: Conversation): boolean {
    const read = this.read[conversation.id] ?? 0
    return conversation.messages.some(
      (message) => message.seq > read && message.author.id !== this.participant?.id,
    )
  }

  dispose(): void {
    this.stop?.()
    this.stop = null
    this.controller?.abort()
    if (this.reload != null) clearTimeout(this.reload)
    this.listeners.clear()
  }

  private receive(event: ConversationEvent): void {
    if (event.seq <= this.seq) return
    this.seq = event.seq
    // Coalesce bursts of events into one reload.
    if (this.reload != null) clearTimeout(this.reload)
    this.reload = setTimeout(() => {
      this.reload = null
      void this.load()
    }, 50)
  }

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}
