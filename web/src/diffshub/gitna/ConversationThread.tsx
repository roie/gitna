import { useEffect, useSyncExternalStore } from 'react'

import { AuthorInitial, CommentComposer } from '@/components/DraftAnnotation'
import { ExampleAnnotation } from '@/components/ExampleAnnotation'
import { annotationCardBase } from '@/lib/annotation'
import { cn } from '@/lib/cn'
import type { Conversation, ConversationsModel } from '../../lib/conversations'

export function ConversationThread({
  conversation: initial,
  model,
}: {
  conversation: Conversation
  model: ConversationsModel
}) {
  useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.version,
  )
  const conversation = model.find(initial.id) ?? initial
  const expanded = model.isExpanded(conversation)
  const unread = model.unread(conversation)
  const first = conversation.messages[0]
  const stale =
    conversation.location?.status === 'outdated' || conversation.location?.status === 'missing'

  useEffect(() => {
    if (expanded && unread) void model.markRead(conversation).catch(() => {})
  }, [expanded, unread, model, conversation])

  if (!expanded) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => model.setExpanded(conversation.id, true)}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        className={cn(annotationCardBase, 'w-full cursor-pointer items-center py-1.5 text-left')}
      >
        <AuthorInitial name={first?.author.name ?? ''} className="size-5 text-[11px]" />
        <span className="min-w-0 flex-1 truncate text-[14px]">
          <strong>{first?.author.name}</strong> {first?.body}
        </span>
        {unread && (
          <span
            role="img"
            aria-label="Unread"
            className="size-2 shrink-0 rounded-full bg-blue-500"
          />
        )}
      </button>
    )
  }

  return (
    <ExampleAnnotation
      messages={conversation.messages.map((message) => ({
        id: message.id,
        author: message.author.name,
        agent: message.author.kind === 'agent',
        message: message.body,
      }))}
      onSelect={() => model.setExpanded(conversation.id, false)}
      onResolve={() => void model.setStatus(conversation, 'resolved')}
      onDelete={() => void model.setDeleted(conversation, true)}
    >
      {stale && conversation.anchor.code !== '' && (
        <pre className="m-0 max-h-40 overflow-auto rounded-md border border-border px-2 py-1 font-mono text-xs">
          {conversation.anchor.code}
        </pre>
      )}
      <CommentComposer
        className="m-0 max-w-none border-0 bg-transparent p-0"
        avatar={<AuthorInitial name={model.participant?.name ?? 'You'} />}
        placeholder="Reply…"
        onSubmit={(body) => model.reply(conversation, body)}
      />
    </ExampleAnnotation>
  )
}
