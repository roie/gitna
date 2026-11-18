import { savePreference } from './preferences'

export interface AgentDefinition {
  id: string
  name: string
  executable: string
  args: string[]
  model?: string
  models?: { default: string; options: { id: string; name: string }[] }
}

export interface FoundAgent {
  name: string
  command: string
  executable: string
  args: string[]
}

export interface AgentSetup {
  name: string
  command: string
  install: string
  website: string
  adapterMissing: boolean
  program: string
  download?: AdapterDownload
}

export interface AdapterDownload {
  source: string
  version: string
  size: number
  folder: string
  requiresNode: boolean
}

export interface InstalledAdapter {
  program: string
  folder: string
  size: number
}

export interface AgentModels {
  default: string
  options: { id: string; name: string }[]
  model: string
}

export interface AgentSettings {
  enabled: boolean
  agents: AgentDefinition[]
  available: FoundAgent[]
  setup: AgentSetup[]
  adapters: InstalledAdapter[]
}

// suggestName names a custom agent after its program, or after the known agent
// that uses that program.
export function suggestName(command: string, known: { name: string; command: string }[]): string {
  const [, double, single, plain] = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command) ?? []
  const program = double ?? single ?? plain ?? ''
  const base = program
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1|js|mjs)$/i, '')
  const match = known.find((k) => k.command.split(' ')[0] === base.toLowerCase())
  return match?.name ?? base.replace(/[-_]acp$/i, '')
}

export interface AuthMethod {
  id: string
  name: string
  description: string
  interactive: boolean
}

export class AgentAuthRequired extends Error {
  constructor(readonly methods: AuthMethod[]) {
    super('Sign in to this agent to continue')
  }
}

export type AddAgent =
  | { name: string; command: string; authMethod?: string }
  | { definition: string; authMethod?: string }
export interface AgentAdded {
  definition: AgentDefinition
  participant: Participant
}

export interface Participant {
  id: string
  kind: 'human' | 'agent'
  name: string
  agent?: string
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
  /** Content identical to additions here, such as the index of a file without unstaged changes. */
  same?: ConversationContent
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
  /** Missing code cannot be shown anywhere, so the conversation is not presented. */
  status: 'current' | 'moved' | 'outdated' | 'missing'
  /** Set when the anchored file is gone but Git still has the code there. */
  source?: 'index' | 'commit'
  revision?: string
}

export interface ConversationMessage {
  id: string
  conversationId: string
  seq: number
  author: Participant
  body: string
  /** The participants this message was addressed to. */
  to?: string[]
  createdAt: string
}

export interface Run {
  id: number
  participantId: string
  messageId: string
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  detail?: string
  startedAt: string
}

export interface Live {
  runId: number
  conversationId: string
  participantId: string
  activity: string
  detail?: string
  text?: string
  permission?: { id: string; title: string; options: { id: string; name: string; kind: string }[] }
}

export interface Conversation {
  runs?: Run[]
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
  /** The joined agents a message can be addressed to. */
  agents: Participant[]
}

export interface ConversationsApi {
  cancelRun(id: number): Promise<unknown>
  answerPermission(id: number, requestId: string, optionId: string): Promise<unknown>
  retry(conversation: string, message: string, participantId: string): Promise<unknown>
  settings(): Promise<AgentSettings>
  setEnabled(enabled: boolean): void
  addAgent(request: AddAgent): Promise<AgentAdded>
  deleteDefinition(id: string): Promise<void>
  installAdapter(program: string, onProgress: (percent: number) => void): Promise<FoundAgent>
  removeAdapter(program: string): Promise<void>
  agentModels(id: string): Promise<AgentModels>
  setAgentModel(id: string, model: string): Promise<unknown>
  renameAgent(id: string, name: string): Promise<unknown>
  leave(participantId: string): Promise<unknown>
  list(path: string, signal?: AbortSignal): Promise<ConversationList>
  create(anchor: ConversationAnchor, body: string, id: string, to?: string[]): Promise<Conversation>
  reply(
    conversationId: string,
    body: string,
    id: string,
    to?: string[],
  ): Promise<ConversationMessage>
  setStatus(conversationId: string, status: 'open' | 'resolved'): Promise<Conversation>
  setDeleted(conversationId: string, deleted: boolean): Promise<Conversation>
  setMessageDeleted(
    conversationId: string,
    messageId: string,
    deleted: boolean,
  ): Promise<Conversation>
  markRead(conversationId: string, seq: number): Promise<number>
  subscribe(
    after: number,
    onEvent: (event: ConversationEvent) => void,
    onLive: (live: Live) => void,
  ): () => void
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
    const raw = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (raw.status === 409) {
      const error = (await raw.clone().json()) as { code?: string; methods?: AuthMethod[] }
      if (error.code === 'auth-required') throw new AgentAuthRequired(error.methods ?? [])
      if (error.code === 'other-process') throw new Error('Running in another Gitna window')
    }
    const response = await expectOK(raw)
    return (await response.json()) as T
  }
  return {
    cancelRun: (id) => post(`api/v1/conversations/runs/${String(id)}/cancel`, {}),
    answerPermission: (id, requestId, optionId) =>
      post(`api/v1/conversations/runs/${String(id)}/permission`, { requestId, optionId }),
    retry: (conversation, message, participant) =>
      post(
        `api/v1/conversations/${encodeURIComponent(conversation)}/messages/${encodeURIComponent(message)}/retry`,
        { participant },
      ),
    async settings() {
      return (await (
        await expectOK(await fetch('api/v1/conversations/settings'))
      ).json()) as AgentSettings
    },
    setEnabled: (enabled) => savePreference('gitna:conversations', String(enabled)),
    addAgent: (request) => post('api/v1/conversations/agents', request),
    async deleteDefinition(id) {
      await expectOK(
        await fetch(`api/v1/conversations/agents/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    },
    async installAdapter(program, onProgress) {
      const response = await expectOK(
        await fetch(`api/v1/conversations/agents/adapters/${encodeURIComponent(program)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffered = ''
      for (;;) {
        const { value, done } = await reader.read()
        buffered += value ?? ''
        const lines = buffered.split('\n')
        buffered = lines.pop()!
        for (const line of lines.filter(Boolean)) {
          const frame = JSON.parse(line) as {
            progress?: number
            found?: FoundAgent
            error?: string
          }
          if (frame.error != null) throw new Error(frame.error)
          if (frame.found != null) return frame.found
          if (frame.progress != null) onProgress(frame.progress)
        }
        if (done) throw new Error('The adapter install ended without a result')
      }
    },
    agentModels: (id) => post(`api/v1/conversations/agents/${encodeURIComponent(id)}/models`, {}),
    setAgentModel: (id, model) =>
      post(`api/v1/conversations/agents/${encodeURIComponent(id)}/model`, { model }),
    renameAgent: (id, name) =>
      post(`api/v1/conversations/agents/${encodeURIComponent(id)}/name`, { name }),
    async removeAdapter(program) {
      await expectOK(
        await fetch(`api/v1/conversations/agents/adapters/${encodeURIComponent(program)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    },
    leave: (id) => post(`api/v1/conversations/participants/${encodeURIComponent(id)}/leave`, {}),
    async list(path, signal) {
      const response = await expectOK(
        await fetch(`api/v1/conversations?path=${encodeURIComponent(path)}`, { signal }),
      )
      return (await response.json()) as ConversationList
    },
    create: (anchor, body, id, to) => post('api/v1/conversations', { id, anchor, body, to }),
    reply: (conversationId, body, id, to) =>
      post(`api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
        id,
        body,
        to,
      }),
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
    setMessageDeleted: (conversationId, messageId, deleted) =>
      post(
        `api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/${deleted ? 'delete' : 'restore'}`,
        {},
      ),
    async markRead(conversationId, seq) {
      const url = `api/v1/conversations/${encodeURIComponent(conversationId)}/read`
      return (await post<{ seq: number }>(url, { seq })).seq
    },
    subscribe(after, onEvent, onLive) {
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
        source.addEventListener('run', (message) => {
          onLive(JSON.parse((message as MessageEvent<string>).data) as Live)
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
  readonly live = new Map<number, Live>()
  unsavedCount = 0
  participant: Participant | null = null
  /** The joined agents a message can explicitly mention. */
  agents: readonly Participant[] = []
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

  displayName(author: Participant): string {
    return author.name
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
      const visible = list.conversations.filter(
        (conversation) => conversation.location?.status !== 'missing',
      )
      const byContent = new Map<string, Conversation[]>()
      for (const conversation of visible) {
        const { location } = conversation
        const key = contentKey(
          location?.source == null ? conversation.anchor : { ...location, source: location.source },
          location?.path ?? conversation.path,
        )
        byContent.set(key, [...(byContent.get(key) ?? []), conversation])
      }
      this.byContent = byContent
      this.all = visible
      for (const conversation of visible) {
        for (const run of conversation.runs ?? []) {
          if (run.state !== 'running') this.live.delete(run.id)
        }
      }
      this.agents = list.agents ?? []
      this.participant = list.participant
      for (const [id, seq] of Object.entries(list.read)) {
        this.read[id] = Math.max(this.read[id] ?? 0, seq)
      }
      this.error = null
      if (this.stop == null) {
        this.seq = list.seq
        this.stop = this.api.subscribe(
          list.seq,
          (event) => this.receive(event),
          (live) => {
            const run = this.find(live.conversationId)?.runs?.find((run) => run.id === live.runId)
            if (run != null && run.state !== 'running') return
            this.live.set(live.runId, live)
            this.emit()
          },
        )
      }
    } catch (error) {
      if (controller.signal.aborted) return
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.emit()
  }

  waiting(conversation: Conversation, message: ConversationMessage): readonly Participant[] {
    return this.agents.filter(
      (agent) =>
        agent.agent != null &&
        message.to?.includes(agent.id) &&
        !(conversation.runs ?? []).some(
          (run) => run.messageId === message.id && run.participantId === agent.id,
        ),
    )
  }

  setUnsavedCount(count: number): void {
    if (this.unsavedCount === count) return
    this.unsavedCount = count
    this.emit()
  }

  async cancelRun(id: number): Promise<void> {
    await this.attempt(async () => {
      await this.api.cancelRun(id)
    })
  }

  async answerPermission(id: number, requestId: string, optionId: string): Promise<void> {
    await this.attempt(async () => {
      await this.api.answerPermission(id, requestId, optionId)
    })
  }

  async retry(
    conversation: Conversation,
    message: ConversationMessage,
    participantId: string,
  ): Promise<void> {
    await this.attempt(async () => {
      await this.api.retry(conversation.id, message.id, participantId)
    })
  }

  async addAgent(request: AddAgent): Promise<AgentAdded> {
    const added = await this.api.addAgent(request)
    await this.load()
    return added
  }

  async leave(id: string): Promise<void> {
    await this.api.leave(id)
    await this.load()
  }

  async renameAgent(id: string, name: string): Promise<void> {
    await this.api.renameAgent(id, name)
    await this.load()
  }

  async create(anchor: ConversationAnchor, body: string, to?: string[]): Promise<Conversation> {
    const conversation = await this.retrying(JSON.stringify([anchor, body, to]), 'c', (id) =>
      this.api.create(anchor, body, id, to),
    )
    this.expanded.set(conversation.id, true)
    await this.load()
    return conversation
  }

  async reply(conversation: Conversation, body: string, to?: string[]): Promise<void> {
    await this.retrying(JSON.stringify([conversation.id, body, to]), 'm', (id) =>
      this.api.reply(conversation.id, body, id, to),
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

  /** The message this tab deleted last, until it is restored or dismissed. */
  recentlyDeletedMessage: { conversation: Conversation; message: ConversationMessage } | null = null

  async setMessageDeleted(
    conversation: Conversation,
    message: ConversationMessage,
    deleted: boolean,
  ): Promise<void> {
    await this.attempt(async () => {
      await this.api.setMessageDeleted(conversation.id, message.id, deleted)
      const recent = deleted ? { conversation, message } : null
      this.recentlyDeletedMessage = recent
      if (recent != null) {
        setTimeout(() => {
          if (this.recentlyDeletedMessage === recent) this.dismissDeletedMessage()
        }, 8000)
      }
    })
  }

  dismissDeletedMessage(): void {
    this.recentlyDeletedMessage = null
    this.emit()
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
