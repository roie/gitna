import { describe, expect, it } from 'vite-plus/test'

import { mentionAt, replyPrefill, resolveMentions } from '../src/lib/mentions'
import type { Conversation, Participant } from '../src/lib/conversations'

const agents: Participant[] = [
  { id: 'a', kind: 'agent', name: 'Agent' },
  { id: 'b', kind: 'agent', name: 'Agent A' },
  { id: 'c', kind: 'agent', name: 'Reviewer' },
]

describe('resolveMentions', () => {
  it.each([
    ['plain comment', []],
    ['mail@Agent', []],
    ['@agent a, please review', ['b']],
    ['@Agentish and @unknown', []],
    ['@Reviewer @Agent @reviewer', ['c', 'a']],
    ['@Agent!\n@Reviewer.', ['a', 'c']],
    ['@Agent @ALL @Reviewer', ['all']],
  ])('resolves %s', (text, ids) => {
    expect(resolveMentions(text, agents)).toEqual(ids)
  })
})

describe('mentionAt', () => {
  it('finds the query at the caret, including spaces in names', () => {
    expect(mentionAt('hello @Agent A later', 14)).toEqual({ start: 6, query: 'Agent A' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('mail@Agent', 10)).toBeNull()
    expect(mentionAt('hello', 5)).toBeNull()
    expect(mentionAt('@Agent\ntext', 11)).toBeNull()
  })
})

describe('replyPrefill', () => {
  const human: Participant = { id: 'h', kind: 'human', name: 'Person' }
  const thread = (messages: { author: Participant; to?: string[] }[]) =>
    ({ messages }) as Conversation

  it('uses the newest human message, not the latest agent reply, and skips agents that left', () => {
    expect(
      replyPrefill(
        thread([
          { author: human, to: ['c'] },
          { author: human, to: ['b', 'gone', 'a'] },
          { author: agents[0]!, to: ['c'] },
        ]),
        agents,
      ),
    ).toBe('@Agent A @Agent ')
  })

  it('does not inherit recipients from an older human message', () => {
    expect(replyPrefill(thread([{ author: human, to: ['a'] }, { author: human }]), agents)).toBe('')
    expect(replyPrefill(thread([]), agents)).toBe('')
  })
})
