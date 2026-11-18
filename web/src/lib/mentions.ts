import type { Conversation, Participant } from './conversations'

export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)@([^@\n\r]*)$/.exec(before)
  if (match == null) return null
  return { start: before.lastIndexOf('@'), query: match[1]! }
}

function* mentions(
  text: string,
  agents: readonly Participant[],
): Generator<{ id: string; start: number; end: number }> {
  const choices = [{ id: 'all', name: 'all' }, ...agents].toSorted(
    (a, b) => b.name.length - a.name.length,
  )
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@' || (index > 0 && !/\s/u.test(text[index - 1]!))) continue
    const rest = text.slice(index + 1).toLowerCase()
    const agent = choices.find(({ name }) => {
      if (!rest.startsWith(name.toLowerCase())) return false
      const next = rest.slice(name.length, name.length + 1)
      return next === '' || /[\s\p{P}]/u.test(next)
    })
    if (agent == null) continue
    yield { id: agent.id, start: index, end: index + 1 + agent.name.length }
    index += agent.name.length
  }
}

export function resolveMentions(text: string, agents: readonly Participant[]): string[] {
  const ids = new Set<string>()
  for (const { id } of mentions(text, agents)) {
    if (id === 'all') return ['all']
    ids.add(id)
  }
  return [...ids]
}

// removeMention deletes every mention of id from text, with the space beside it.
export function removeMention(text: string, id: string, agents: readonly Participant[]): string {
  let out = ''
  let from = 0
  for (const mention of mentions(text, agents)) {
    if (mention.id !== id) continue
    out += text.slice(from, mention.start)
    from = mention.end
    if (text[from] === ' ') from++
    else if (out.endsWith(' ')) out = out.slice(0, -1)
  }
  return out + text.slice(from)
}

export function replyRecipients(
  conversation: Conversation,
  agents: readonly Participant[],
): string[] {
  const message = conversation.messages.findLast(({ author }) => author.kind === 'human')
  return (message?.to ?? []).filter((id) => agents.some((agent) => agent.id === id))
}
