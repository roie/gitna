import { describe, expect, it, vi } from 'vite-plus/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Thread } from '../src/diffshub/gitna/Thread'
import { CommentComposer } from '../src/diffshub/components/DraftAnnotation'

import {
  captureLines,
  createConversationsApi,
  ConversationsModel,
  suggestName,
  type Conversation,
  type ConversationEvent,
  type ConversationsApi,
  type Participant,
  type Live,
} from '../src/lib/conversations'

vi.mock('@pierre/icons', () => ({
  IconArrowRight: () => null,
  IconX: () => null,
  IconCheck: () => null,
  IconEllipsis: () => null,
  IconPlus: () => null,
  IconChevronSm: () => null,
  IconCircleFill: () => null,
}))

const worktree = { source: 'worktree' } as const
const human = { id: 'human:local', kind: 'human', name: 'Ada' } as const
const agent = { id: 'agent:helper', kind: 'agent', name: 'helper' } as const

function conversation(
  id: string,
  path: string,
  seqs: [number, typeof human | typeof agent][],
): Conversation {
  return {
    id,
    anchor: {
      path: 'old.go',
      view: 'file',
      source: 'worktree',
      side: 'additions',
      startLine: 1,
      endLine: 1,
      code: 'x',
    },
    path,
    location: { path, startLine: 3, endLine: 3, status: 'moved' },
    status: 'open',
    createdBy: human,
    createdAt: '',
    updatedAt: '',
    seq: seqs.at(-1)![0],
    messages: seqs.map(([seq, author]) => ({
      id: `${id}-${String(seq)}`,
      conversationId: id,
      seq,
      author,
      body: 'b',
      createdAt: '',
    })),
  }
}

function fakeApi(lists: Conversation[][], agents: Participant[] = []) {
  let emit: (event: ConversationEvent) => void = () => {}
  let emitLive: (live: Live) => void = () => {}
  const list = vi.fn(async () => ({
    participant: human,
    conversations: lists.shift() ?? [],
    seq: 2,
    read: {},
    agents,
  }))
  const markRead = vi.fn(async (_id: string, seq: number) => seq)
  const subscribe = vi.fn(
    (_after: number, onEvent: (event: ConversationEvent) => void, onLive: (live: Live) => void) => {
      emit = onEvent
      emitLive = onLive
      return () => {}
    },
  )
  const api: ConversationsApi = {
    cancelRun: vi.fn(),
    answerPermission: vi.fn(),
    retry: vi.fn(),
    settings: vi.fn(),
    setEnabled: vi.fn(),
    addAgent: vi.fn(),
    deleteDefinition: vi.fn(),
    installAdapter: vi.fn(),
    removeAdapter: vi.fn(),
    agentModels: vi.fn(),
    setAgentModel: vi.fn(),
    renameAgent: vi.fn(),
    leave: vi.fn(),
    list,
    create: vi.fn(),
    reply: vi.fn(),
    setStatus: vi.fn(),
    setDeleted: vi.fn(),
    setMessageDeleted: vi.fn(),
    markRead,
    subscribe,
  }
  return {
    api,
    list,
    markRead,
    subscribe,
    emit: (event: ConversationEvent) => emit(event),
    emitLive: (live: Live) => emitLive(live),
  }
}

async function loaded(list: Conversation[], agents: Participant[]) {
  const model = new ConversationsModel(fakeApi([list], agents).api)
  await model.load()
  return model
}

describe('native run presentation', () => {
  const native = { ...agent, agent: 'definition' }
  const run = {
    id: 3,
    participantId: agent.id,
    messageId: 'c-1',
    state: 'running' as const,
    startedAt: '',
  }
  const live = { runId: 3, participantId: agent.id, conversationId: 'c', activity: 'Read a file' }
  const render = (model: ConversationsModel, thread: Conversation) =>
    renderToStaticMarkup(createElement(Thread, { model, conversation: thread }))

  it('shows activity and removes live state when the reply completes the run', async () => {
    const thread = conversation('c', 'a', [[1, human]])
    thread.runs = [run]
    const f = fakeApi([[thread]], [native])
    const model = new ConversationsModel(f.api)
    await model.load()
    f.emit({ seq: 3, type: 'run.started', conversationId: 'c', actor: native })
    f.emitLive(live)
    expect(render(model, thread)).toContain('Read a file')
    expect(render(model, thread)).toContain('role="status"')
    f.emitLive({ ...live, text: 'Partial **answer**' })
    expect(render(model, thread)).toMatch(/<strong[^>]*>answer<\/strong>/)
    thread.runs[0] = { ...run, state: 'completed' }
    f.list.mockResolvedValueOnce({
      participant: human,
      conversations: [thread],
      seq: 4,
      read: {},
      agents: [native],
    })
    await model.load()
    expect(model.live.size).toBe(0)
    expect(render(model, thread)).not.toContain('Read a file')
    model.dispose()
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'shows %s detail and Retry',
    async (state) => {
      const thread = conversation('c', 'a', [[1, human]])
      thread.runs = [{ ...run, state, detail: 'Connection ended' }]
      const model = await loaded([thread], [native])
      const html = render(model, thread)
      expect(html).toContain(state[0]!.toUpperCase() + state.slice(1))
      expect(html).toContain('Connection ended')
      expect(html).toContain('Retry')
      model.dispose()
    },
  )

  it('shows permission option names and posts the chosen option ID', async () => {
    const thread = conversation('c', 'a', [[1, human]])
    thread.runs = [run]
    const f = fakeApi([[thread]], [native])
    const answerPermission = vi.fn().mockResolvedValue({})
    f.api.answerPermission = answerPermission
    const model = new ConversationsModel(f.api)
    await model.load()
    f.emitLive({
      ...live,
      permission: {
        id: 'request',
        title: 'Write a file',
        options: [{ id: 'yes', name: 'Allow once', kind: 'allow_once' }],
      },
    })
    expect(render(model, thread)).toContain('Allow once')
    await model.answerPermission(3, 'request', 'yes')
    expect(answerPermission).toHaveBeenCalledWith(3, 'request', 'yes')
    model.dispose()
  })

  it('shows when another Gitna owns a run', async () => {
    const api = createConversationsApi(
      vi.fn().mockResolvedValue(Response.json({ code: 'other-process' }, { status: 409 })),
      async (response) => response,
    )
    await expect(api.cancelRun(3)).rejects.toThrow('Running in another Gitna window')
  })

  it('derives Waiting only for joined native recipients without a run', async () => {
    const thread = conversation('c', 'a', [[1, human]])
    thread.messages[0]!.to = [native.id, 'agent:cli', 'agent:left']
    const model = await loaded([thread], [native, { id: 'agent:cli', kind: 'agent', name: 'CLI' }])
    expect(model.waiting(thread, thread.messages[0]!)).toEqual([native])
    expect(render(model, thread)).toContain('Waiting')
    thread.runs = [run]
    expect(model.waiting(thread, thread.messages[0]!)).toEqual([])
    expect(render(model, thread)).not.toContain('Waiting')
    model.dispose()
  })

  it('shows unsaved guidance only with recipients and unsaved files', () => {
    const composer = (text: string, unsavedCount: number) =>
      renderToStaticMarkup(
        createElement(CommentComposer, {
          avatar: null,
          agents: [native],
          initialText: text,
          unsavedCount,
          onSubmit: vi.fn(),
        }),
      )
    expect(composer('@helper fix', 2)).toContain('2 unsaved files')
    expect(composer('fix', 2)).not.toContain('unsaved')
    expect(composer('@helper fix', 0)).not.toContain('unsaved')
  })
})

describe('agent settings', () => {
  it('posts a command and refreshes the repository roster', async () => {
    const { api, list } = fakeApi([[]], [agent])
    const addAgent = vi.fn().mockResolvedValue({
      definition: { id: 'd', name: 'helper', executable: '/bin/helper', args: [] },
      participant: agent,
    })
    api.addAgent = addAgent
    const model = new ConversationsModel(api)
    const request = { name: 'helper', command: 'helper --acp' }
    await model.addAgent(request)
    expect(addAgent).toHaveBeenCalledWith(request)
    expect(list).toHaveBeenCalledOnce()
    expect(model.agents).toEqual([agent])
  })

  it('exposes authentication methods and sends the selected method on retry', async () => {
    const methods = [
      { id: 'login', name: 'Sign in', description: 'Open a browser', interactive: false },
    ]
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'auth-required', methods }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ participant: agent }))
    const api = createConversationsApi(fetch, async (response) => response)
    await expect(api.addAgent({ name: 'helper', command: 'helper' })).rejects.toMatchObject({
      methods,
    })
    await api.addAgent({ name: 'helper', command: 'helper', authMethod: 'login' })
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      name: 'helper',
      command: 'helper',
      authMethod: 'login',
    })
  })

  it('keeps the server verification error', async () => {
    const api = createConversationsApi(
      vi.fn().mockResolvedValue(Response.json({ error: 'Not an ACP agent' }, { status: 422 })),
      async (response) => {
        if (!response.ok) throw new Error((await response.json()).error)
        return response
      },
    )
    await expect(api.addAgent({ name: 'helper', command: 'bad' })).rejects.toThrow(
      'Not an ACP agent',
    )
  })

  it('refreshes the roster after leaving', async () => {
    const { api } = fakeApi([[]])
    const leave = vi.fn().mockResolvedValue({})
    api.leave = leave
    const model = new ConversationsModel(api)
    model.agents = [agent]
    await model.leave(agent.id)
    expect(leave).toHaveBeenCalledWith(agent.id)
    expect(model.agents).toEqual([])
  })
})

describe('ConversationsModel', () => {
  it('indexes threads by their current location and tracks unread agent replies', async () => {
    const { api, markRead } = fakeApi([
      [
        conversation('c1', 'new.go', [
          [1, human],
          [2, agent],
        ]),
      ],
    ])
    const model = new ConversationsModel(api)
    await model.load()

    expect(model.get(worktree, 'old.go')).toEqual([])
    expect(model.get({ source: 'index' }, 'new.go')).toEqual([])
    const [thread] = model.get(worktree, 'new.go')
    expect(thread?.id).toBe('c1')
    expect(model.unread(thread!)).toBe(true)
    expect(model.isExpanded(thread!)).toBe(true)

    await model.markRead(thread!)
    expect(markRead).toHaveBeenCalledWith('c1', 2)
    expect(model.unread(thread!)).toBe(false)
  })

  it('reloads once for a burst of live events and ignores replays', async () => {
    vi.useFakeTimers()
    const { api, list, subscribe, emit } = fakeApi([[], [conversation('c1', 'a.go', [[3, agent]])]])
    const model = new ConversationsModel(api)
    await model.load()
    expect(subscribe).toHaveBeenCalledWith(2, expect.any(Function), expect.any(Function))

    emit({ seq: 2, type: 'message.created', conversationId: 'c1', actor: agent })
    emit({ seq: 3, type: 'message.created', conversationId: 'c1', actor: agent })
    emit({ seq: 4, type: 'conversation.resolved', conversationId: 'c1', actor: agent })
    await vi.runAllTimersAsync()
    vi.useRealTimers()

    expect(list).toHaveBeenCalledTimes(2)
    expect(model.get(worktree, 'a.go').map((item) => item.id)).toEqual(['c1'])
  })

  it('keeps commit conversations apart by revision', async () => {
    const pinned = conversation('c1', 'a.go', [[1, human]])
    pinned.anchor = { ...pinned.anchor, path: 'a.go', source: 'commit', revision: 'abc' }
    const model = new ConversationsModel(fakeApi([[pinned]]).api)
    await model.load()

    expect(model.get({ source: 'commit', revision: 'abc' }, 'a.go')).toHaveLength(1)
    expect(model.get({ source: 'commit', revision: 'def' }, 'a.go')).toEqual([])
    expect(model.get(worktree, 'a.go')).toEqual([])
  })

  it('hides missing code and shows deleted files where Git still has them', async () => {
    const gone = conversation('gone', 'u.txt', [[1, human]])
    gone.location = { path: 'u.txt', startLine: 1, endLine: 1, status: 'missing' }
    const kept = conversation('kept', 'f.go', [[2, human]])
    kept.location = {
      path: 'f.go',
      startLine: 1,
      endLine: 1,
      status: 'current',
      source: 'commit',
      revision: 'abc',
    }
    const model = new ConversationsModel(fakeApi([[gone, kept]]).api)
    await model.load()

    expect(model.list().map(({ id }) => id)).toEqual(['kept'])
    expect(model.get(worktree, 'u.txt')).toEqual([])
    expect(model.get(worktree, 'f.go')).toEqual([])
    expect(model.get({ source: 'commit', revision: 'abc' }, 'f.go')).toHaveLength(1)
  })

  it('uses the names assigned when participants joined', async () => {
    const first = { id: 'agent:p_aaaa1111', kind: 'agent', name: 'Agent' } as const
    const second = { id: 'agent:p_bbbb2222', kind: 'agent', name: 'Agent' } as const
    const thread = conversation('c1', 'a.go', [[1, human]])
    thread.messages.push(
      { ...thread.messages[0]!, id: 'm2', seq: 2, author: first },
      { ...thread.messages[0]!, id: 'm3', seq: 3, author: second },
    )
    const model = new ConversationsModel(fakeApi([[thread]]).api)
    await model.load()

    expect(model.displayName(human)).toBe('Ada')
    expect(model.displayName(first)).toBe('Agent')
    expect(model.displayName(second)).toBe('Agent')
  })

  it('keeps the joined agents for explicit mentions', async () => {
    const thread = conversation('c1', 'a.go', [[1, human]])
    const model = await loaded([thread], [agent])
    expect(model.agents).toEqual([agent])
  })

  it('reports a failed resolve or delete instead of throwing, and remembers deletes for undo', async () => {
    const thread = conversation('c1', 'a.go', [[1, human]])
    const { api } = fakeApi([[thread], [], []])
    const model = new ConversationsModel(api)
    await model.load()

    api.setStatus = vi.fn().mockRejectedValueOnce(new Error('offline'))
    await model.setStatus(thread, 'resolved')
    expect(model.error).toBe('offline')
    model.dismissError()

    api.setDeleted = vi.fn().mockResolvedValue(thread)
    await model.setDeleted(thread, true)
    expect(model.recentlyDeleted).toBe(thread)
    expect(model.list()).toEqual([])
    await model.setDeleted(thread, false)
    expect(model.recentlyDeleted).toBeNull()
    expect(model.error).toBeNull()
  })

  it('retries a failed reply with the same message id', async () => {
    const thread = conversation('c1', 'a.go', [[1, human]])
    const { api } = fakeApi([[thread], [thread], [thread]])
    const model = new ConversationsModel(api)
    await model.load()
    const reply = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({})
    api.reply = reply

    await expect(model.reply(thread, 'hello')).rejects.toThrow('lost')
    await model.reply(thread, 'hello')
    await model.reply(thread, 'hello')
    const ids = reply.mock.calls.map((call) => call[2] as string)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
  })

  it('captures selected lines with their context', () => {
    const lines = ['1\n', '2\r\n', '3', '4', '5', '6', '7']
    expect(captureLines(lines, 2, 3)).toEqual({ code: '2\n3', before: '1', after: '4\n5\n6' })
    expect(captureLines(lines, 1, 1).before).toBe('')
  })
})

describe('custom agent name suggestions', () => {
  const known = [{ name: 'OpenCode', command: 'opencode acp' }]
  it.each([
    ['my-agent --acp', 'my-agent'],
    ['"C:\\Program Files\\Agent\\helper-acp.exe" --acp', 'helper'],
    ['/usr/local/bin/opencode acp', 'OpenCode'],
    ['node ./agent.mjs', 'node'],
    ['', ''],
  ])('%s → %s', (command, name) => {
    expect(suggestName(command, known)).toBe(name)
  })
})
