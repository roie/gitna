import type { Conversation, Participant } from './conversations'

export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)@([^@\n\r]*)$/.exec(before)
  if (match == null) return null
  return { start: before.lastIndexOf('@'), query: match[1]! }
}

export function resolveMentions(text: string, agents: readonly Participant[]): string[] {
  const choices = [{ id: 'all', name: 'all' }, ...agents].toSorted(
    (a, b) => b.name.length - a.name.length,
  )
  const ids = new Set<string>()
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@' || (index > 0 && !/\s/u.test(text[index - 1]!))) continue
    const rest = text.slice(index + 1).toLowerCase()
    const agent = choices.find(({ name }) => {
      if (!rest.startsWith(name.toLowerCase())) return false
      const next = rest.slice(name.length, name.length + 1)
      return next === '' || /[\s\p{P}]/u.test(next)
    })
    if (agent == null) continue
    if (agent.id === 'all') return ['all']
    ids.add(agent.id)
    index += agent.name.length
  }
  return [...ids]
}

export function replyPrefill(conversation: Conversation, agents: readonly Participant[]): string {
  const message = conversation.messages.findLast(({ author }) => author.kind === 'human')
  return (message?.to ?? [])
    .flatMap((id) => {
      const agent = agents.find((candidate) => candidate.id === id)
      return agent == null ? [] : [`@${agent.name} `]
    })
    .join('')
}
