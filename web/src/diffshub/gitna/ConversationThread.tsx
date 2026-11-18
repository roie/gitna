import { useEffect, useSyncExternalStore } from 'react'

import { AuthorInitial, CommentComposer } from '@/components/DraftAnnotation'
import { Button } from '@/components/Button'
import { ExampleAnnotation } from '@/components/ExampleAnnotation'
import { annotationCardBase } from '@/lib/annotation'
import { cn } from '@/lib/cn'
import type { Conversation, ConversationsModel, Run } from '../../lib/conversations'
import { replyRecipients, resolveMentions } from '../../lib/mentions'
import { MessageMarkdown } from './MessageMarkdown'

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
    () => model.version,
  )
  const conversation = model.find(initial.id) ?? initial
  const expanded = model.isExpanded(conversation)
  const unread = model.unread(conversation)
  const first = conversation.messages[0]
  const agentName = (run: Run) =>
    model.agents.find((agent) => agent.id === run.participantId)?.name ?? 'Agent'
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
          <strong>{first == null ? '' : model.displayName(first.author)}</strong> {first?.body}
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
      messages={[
        ...conversation.messages.map((message) => ({
          id: message.id,
          author: model.displayName(message.author),
          agent: message.author.kind === 'agent',
          message:
            message.author.kind === 'agent' ? (
              <MessageMarkdown body={message.body} />
            ) : (
              message.body
            ),
          after: (
            <div className="flex flex-col gap-2 text-xs">
              {message.author.kind === 'human' &&
                (message.to ?? []).some(
                  (id) => !resolveMentions(message.body, model.agents).includes(id),
                ) && (
                  <p className="m-0 text-muted-foreground">
                    To:{' '}
                    {(message.to ?? [])
                      .map((id) =>
                        id === 'all'
                          ? 'all'
                          : (model.agents.find((agent) => agent.id === id)?.name ?? id),
                      )
                      .join(', ')}
                  </p>
                )}
              {model.waiting(conversation, message).map((agent) => (
                <p key={agent.id} role="status" className="m-0 text-muted-foreground">
                  {agent.name}: Waiting
                </p>
              ))}
              {latestRuns(conversation.runs ?? [], message.id)
                .filter((run) => run.state !== 'completed' && run.state !== 'running')
                .map((run) => (
                  <div key={run.id} className="flex flex-col gap-1">
                    <p role="status" className="m-0 text-muted-foreground">
                      {agentName(run)}: {run.state[0]!.toUpperCase() + run.state.slice(1)}
                      {run.detail == null || run.detail === '' ? '' : `: ${run.detail}`}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void model.retry(conversation, message, run.participantId)}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          ),
        })),
        ...(conversation.runs ?? [])
          .filter((run) => run.state === 'running')
          .map((run) => {
            const live = model.live.get(run.id)
            return {
              id: `run-${run.id}`,
              author: agentName(run),
              agent: true,
              live: true,
              message:
                live?.text == null || live.text === '' ? null : (
                  <MessageMarkdown body={live.text} />
                ),
              after: (
                <div className="flex flex-col gap-1 text-xs">
                  {live?.permission == null && live?.detail ? (
                    <details role="status" className="text-muted-foreground">
                      <summary className="cursor-pointer">{live.activity}…</summary>
                      <code className="mt-1 block font-mono break-all whitespace-pre-wrap">
                        {live.detail}
                      </code>
                    </details>
                  ) : (
                    <p role="status" className="m-0 text-muted-foreground">
                      {live?.permission?.title ?? `${live?.activity ?? 'Writing a reply'}…`}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {live?.permission?.options.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void model.answerPermission(run.id, live.permission!.id, option.id)
                        }
                      >
                        {option.name}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void model.cancelRun(run.id)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ),
            }
          }),
      ]}
      onSelect={() => model.setExpanded(conversation.id, false)}
      onResolve={() => void model.setStatus(conversation, 'resolved')}
      onDelete={() => void model.setDeleted(conversation, true)}
      onDeleteMessage={(id) => {
        const message = conversation.messages.find((candidate) => candidate.id === id)
        if (message != null) void model.setMessageDeleted(conversation, message, true)
      }}
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
        agents={model.agents}
        unsavedCount={model.unsavedCount}
        initialTo={replyRecipients(conversation, model.agents)}
        onSubmit={(body, to) => model.reply(conversation, body, to)}
      />
    </ExampleAnnotation>
  )
}

// latestRuns returns the newest run of each agent for a message: a retry
// replaces the run it retried.
function latestRuns(runs: Run[], messageId: string): Run[] {
  const latest = new Map<string, Run>()
  for (const run of runs) {
    if (run.messageId !== messageId) continue
    const previous = latest.get(run.participantId)
    if (previous == null || run.id > previous.id) latest.set(run.participantId, run)
  }
  return [...latest.values()]
}
