import { IconEllipsis, IconRefresh } from '@pierre/icons'
import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/modal'
import { message, type PendingConfirm } from '../../components/tree-section'
import { Button } from '../../components/ui/button'
import { CHROME_ICON_BUTTON_CLASS } from '../../components/ui/button-styles'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { useLoadingIndicator } from '../../components/ui/loading'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip'
import { ApiError } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useRepository } from '../../repository/repository'
import { BranchPicker } from './branch-picker'
import type { OperationDialog } from './operation-modal'

interface SourceControlHeaderActionsProps {
  moreTrigger: React.RefObject<HTMLButtonElement | null>
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
  onOpenDialog: (dialog: Exclude<OperationDialog, null>) => void
}

export function SourceControlHeaderActions({
  moreTrigger,
  onConfirm,
  onError,
  onOpenDialog,
}: SourceControlHeaderActionsProps) {
  const repository = useRepository()
  const [moreOpen, setMoreOpen] = useState(false)
  const [publishBranch, setPublishBranch] = useState<string | null>(null)
  const fetching = repository.activeOp === 'Fetching'
  const disabledReason = repository.getActionDisabledReason()
  const fetchRefreshVisible = useLoadingIndicator(fetching)
  const [publishRemote, setPublishRemote] = useState('')
  const remotes = repository.remotes

  useEffect(() => {
    if (remotes.includes(publishRemote)) return
    setPublishRemote(remotes[0] ?? '')
  }, [publishRemote, remotes])

  const run = useCallback(
    async (action: () => Promise<void>) => {
      const reason = repository.getActionDisabledReason()
      if (reason != null) {
        onError(reason)
        return
      }
      onError(null)
      try {
        await action()
      } catch (error) {
        onError(message(error))
      }
    },
    [onError],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F1') return
      event.preventDefault()
      setMoreOpen((open) => !open)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const push = useCallback(async () => {
    onError(null)
    try {
      await repository.operation({ op: 'push' })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no-upstream') {
        const branch = error.branch ?? repository.snapshot?.headBranch
        if (branch == null || branch.trim() === '') {
          onError(message(error))
          return
        }
        setPublishBranch(branch)
        if (remotes[0] != null) setPublishRemote(remotes[0])
      } else {
        onError(message(error))
      }
    }
  }, [onError, remotes, repository])

  const snapshot = repository.snapshot
  const upstream = snapshot?.upstream
  const unpublished = (snapshot?.headBranch?.trim() ?? '') !== '' && upstream == null
  const syncLabel =
    upstream == null || snapshot == null || (snapshot.ahead === 0 && snapshot.behind === 0)
      ? null
      : [
          snapshot.ahead > 0 ? `↑${snapshot.ahead}` : '',
          snapshot.behind > 0 ? `↓${snapshot.behind}` : '',
        ]
          .filter(Boolean)
          .join(' ')
  const syncDescription =
    upstream == null || snapshot == null
      ? ''
      : [
          snapshot.ahead > 0
            ? `${snapshot.ahead} outgoing ${snapshot.ahead === 1 ? 'commit' : 'commits'}`
            : null,
          snapshot.behind > 0
            ? `${snapshot.behind} incoming ${snapshot.behind === 1 ? 'commit' : 'commits'}`
            : null,
        ]
          .filter((part): part is string => part != null)
          .join(', ') + ` · ${upstream}`

  return (
    <>
      <BranchPicker onConfirm={onConfirm} onError={onError} run={run} />
      <Button
        variant="ghost"
        size="icon-only"
        disabled={repository.busy || disabledReason != null}
        aria-label={fetching ? 'Fetching' : 'Fetch'}
        title={disabledReason ?? (fetching ? 'Fetching' : 'Fetch')}
        className={CHROME_ICON_BUTTON_CLASS}
        onClick={() => void run(() => repository.operation({ op: 'fetch' }))}
      >
        <IconRefresh
          className={cn(
            'size-4 motion-reduce:animate-none md:size-3',
            fetchRefreshVisible && 'animate-spin',
          )}
        />
      </Button>
      {unpublished && (
        <Button
          variant="ghost"
          size="xs"
          disabled={repository.busy || disabledReason != null}
          aria-label="Publish branch"
          title={disabledReason ?? 'Publish branch'}
          onClick={() => void push()}
        >
          Publish
        </Button>
      )}
      {syncLabel != null && (
        <TooltipProvider delayDuration={400} skipDelayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                disabled={repository.busy}
                aria-label={syncDescription}
                onClick={() => setMoreOpen(true)}
              >
                {syncLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{syncDescription}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <DropdownMenu
        open={moreOpen}
        onOpenChange={(open) => {
          setMoreOpen(open)
          if (!open) return
          void repository.refreshBranches()
          void repository.refreshStashes()
          void repository.refreshTags()
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={moreTrigger}
            variant="ghost"
            size="icon-only"
            aria-label="More actions"
            data-menu-focus-fallback
            title="More actions"
            className={CHROME_ICON_BUTTON_CLASS}
          >
            <IconEllipsis className="size-4 md:size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={disabledReason != null}
            onSelect={() => void run(() => repository.operation({ op: 'pull' }))}
          >
            Pull
          </DropdownMenuItem>
          <DropdownMenuItem disabled={disabledReason != null} onSelect={() => void push()}>
            Push
          </DropdownMenuItem>
          {upstream != null && snapshot != null && snapshot.behind > 0 && (
            <DropdownMenuItem
              onSelect={() =>
                void repository.openCompare('HEAD', upstream, `Incoming from ${upstream}`)
              }
            >
              Review incoming ({snapshot.behind})
            </DropdownMenuItem>
          )}
          {upstream != null && snapshot != null && snapshot.ahead > 0 && (
            <DropdownMenuItem
              onSelect={() =>
                void repository.openCompare(upstream, 'HEAD', `Outgoing to ${upstream}`)
              }
            >
              Review outgoing ({snapshot.ahead})
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void repository.refreshGraph()}>
            Refresh Graph
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenDialog('compare')}>
            Compare refs…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenDialog('integrate')}>
            Merge or rebase…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenDialog('stash')}>Stashes…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenDialog('tags')}>Tags…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {publishBranch != null && (
        <Modal
          title={`Publish ${publishBranch}`}
          disabledReason={disabledReason}
          onClose={() => setPublishBranch(null)}
        >
          <div className="flex items-center gap-2 text-xs" role="status">
            <span className="min-w-0 flex-1 truncate">
              <b>{publishBranch}</b> has no upstream
            </span>
            <select
              aria-label="Publish remote"
              className="cursor-pointer rounded border border-border bg-background px-1 py-1 outline-none focus:border-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={remotes.length === 0}
              value={publishRemote}
              onChange={(event) => setPublishRemote(event.currentTarget.value)}
            >
              {remotes.length === 0 && <option value="">No remotes configured</option>}
              {remotes.map((remote) => (
                <option key={remote}>{remote}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="xs"
              disabled={publishRemote === '' || publishBranch.trim() === ''}
              onClick={() =>
                void run(async () => {
                  if (publishBranch.trim() === '') return
                  await repository.operation({
                    op: 'push-upstream',
                    remote: publishRemote,
                    name: publishBranch,
                  })
                  setPublishBranch(null)
                })
              }
            >
              Publish
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
