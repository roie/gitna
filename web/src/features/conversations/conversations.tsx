import { IconComment, IconFilter } from '@pierre/icons'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Agents } from './agents'
import type { Conversation, ConversationsModel, Participant } from '../../lib/conversations'
import { Button } from '../../components/ui/button'
import { CHROME_ICON_BUTTON_CLASS } from '../../components/ui/button-styles'
import { ConversationList } from './conversation-list'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { cn } from '../../lib/cn'
import type { DiffsHubSavedCommentItem } from '../../lib/review-types'
import { Header } from '../../components/ui/header'

export interface ConversationsPane {
  model: ConversationsModel
  onOpen: (conversation: Conversation) => void
}

function conversationSections(
  list: readonly Conversation[],
  name: (author: Participant) => string,
): DiffsHubSavedCommentItem[] {
  const byPath = new Map<string, DiffsHubSavedCommentItem>()
  for (const conversation of list) {
    const path = conversation.location?.path ?? conversation.path
    const start = conversation.location?.startLine ?? conversation.anchor.startLine
    const end = conversation.location?.endLine ?? conversation.anchor.endLine
    const { side } = conversation.anchor
    let section = byPath.get(path)
    if (section == null) {
      section = { itemId: path, path, fileOrder: byPath.size, comments: [] }
      byPath.set(path, section)
    }
    section.comments.push({
      key: conversation.id,
      itemId: path,
      author: name(conversation.messages[0]?.author ?? conversation.createdBy),
      message: conversation.messages[0]?.body ?? '',
      lineNumber: start,
      lineType: 'context',
      side,
      range: { start, end, side },
    })
  }
  return [...byPath.values()]
}

export function Conversations({
  conversations: { model, onOpen },
  open,
  onOpenChange,
}: {
  conversations: ConversationsPane
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  useSyncExternalStore(
    useCallback((listener: () => void) => model.subscribe(listener), [model]),
    () => model.version,
  )
  const list = model.list()
  const [filter, setFilter] = useState<'open' | 'resolved'>('open')
  const openCount = list.filter(({ status }) => status === 'open').length
  const sections = useMemo(
    () =>
      conversationSections(
        list.filter(({ status }) => status === filter),
        (author) => model.displayName(author),
      ),
    [list, filter, model],
  )
  return (
    <section
      data-pane="conversations"
      className="section flex min-h-0 flex-col overflow-hidden max-md:max-h-[50vh]"
    >
      <Header
        level="pane"
        actions={
          <>
            <Agents model={model} />
            <ConversationFilter value={filter} onChange={setFilter} />
          </>
        }
        count={openCount || null}
        countTitle={`${openCount} open conversations`}
        dataSection="conversations"
        icon={IconComment}
        open={open}
        title="Conversations"
        accessory={
          list.some((conversation) => model.unread(conversation)) && (
            <span
              role="img"
              aria-label="Unread"
              className="size-2 shrink-0 rounded-full bg-highlight"
            />
          )
        }
        onOpenChange={onOpenChange}
      />
      {open && (
        <div className="min-h-0 flex-1">
          <ConversationList
            commentSections={sections}
            emptyTitle={`No ${filter} conversations`}
            onSelectComment={({ key }) => {
              const conversation = model.find(key)
              if (conversation != null) onOpen(conversation)
            }}
            onReopen={
              filter === 'resolved'
                ? ({ key }) => {
                    const conversation = model.find(key)
                    if (conversation != null) void model.setStatus(conversation, 'open')
                  }
                : undefined
            }
          />
        </div>
      )}
    </section>
  )
}

function ConversationFilter({
  value,
  onChange,
}: {
  value: 'open' | 'resolved'
  onChange: (value: 'open' | 'resolved') => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-only"
          aria-label="Filter conversations"
          aria-pressed={value === 'resolved'}
          className={cn(CHROME_ICON_BUTTON_CLASS, 'relative')}
          title="Filter conversations"
        >
          <IconFilter className="size-4 md:size-3" />
          {value === 'resolved' && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-[1px] border-[var(--diffshub-sidebar-bg)] bg-highlight"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="p-2">
        {(['open', 'resolved'] as const).map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={value === option}
            indicatorSide="right"
            onCheckedChange={() => onChange(option)}
          >
            {option === 'open' ? 'Open' : 'Resolved'}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
