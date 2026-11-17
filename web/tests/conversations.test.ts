import { describe, expect, it, vi } from 'vite-plus/test'

import {
  captureLines,
  createConversationsApi,
  ConversationsModel,
  type Conversation,
  type ConversationEvent,
  type ConversationsApi,
  type Participant,
} from '../src/lib/conversations'

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
  const list = vi.fn(async () => ({
    participant: human,
    conversations: lists.shift() ?? [],
    seq: 2,
    read: {},
    agents,
  }))
  const markRead = vi.fn(async (_id: string, seq: number) => seq)
  const subscribe = vi.fn((_after: number, onEvent: (event: ConversationEvent) => void) => {
    emit = onEvent
    return () => {}
  })
  const api: ConversationsApi = {
    settings: vi.fn(),
    setEnabled: vi.fn(),
    addAgent: vi.fn(),
    deleteDefinition: vi.fn(),
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
  return { api, list, markRead, subscribe, emit: (event: ConversationEvent) => emit(event) }
}

async function loaded(list: Conversation[], agents: Participant[]) {
  const model = new ConversationsModel(fakeApi([list], agents).api)
  await model.load()
  return model
}

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
    expect(subscribe).toHaveBeenCalledWith(2, expect.any(Function))

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
