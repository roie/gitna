import {
  IconBranch,
  IconEllipsis,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconReply,
  IconSymbolDiffstatFill,
} from '@pierre/icons'
import type { ContextMenuItem, ContextMenuOpenContext, FileTreeOptions } from '@pierre/trees'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import type { ChangeScope, ConflictEntry } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { CHROME_ICON_BUTTON_CLASS } from '../../components/ui/button-styles'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { useLoadingIndicator } from '../../components/ui/loading'
import type { FileTreeSource } from '../../lib/review-types'
import { Modal } from '../../components/modal'
import { useRepository } from '../../repository/repository'
import { Header } from '../../components/ui/header'
import { Pane } from '../../components/ui/pane'
import {
  type PendingConfirm,
  message,
  trimDirectoryPath,
  type TreeFile,
  createTreeSource,
  FileTreeContextMenuTrigger,
  TreeSection,
} from '../../components/tree-section'

type OperationDialog = 'compare' | 'integrate' | 'stash' | 'tags' | null

interface DiscardConfirmationCopy {
  confirmLabel: string
  message: string
  title: string
}

function discardConfirmationCopy(
  name: string | null,
  changes: readonly TreeFile[],
  group: boolean,
): DiscardConfirmationCopy {
  const untracked = changes.filter((change) => change.kind === 'untracked').length
  const tracked = changes.length - untracked

  if (!group && name != null && changes.length === 1) {
    return untracked === 1
      ? {
          title: `Delete untracked file ${name}?`,
          message: 'This permanently deletes the file. This cannot be undone.',
          confirmLabel: 'Delete file',
        }
      : {
          title: `Discard changes to ${name}?`,
          message: 'The file will be restored to its staged version. This cannot be undone.',
          confirmLabel: 'Discard changes',
        }
  }

  const scope = name == null ? 'all changes' : `changes in ${name}`
  const effects = [
    tracked > 0 ? `restore ${tracked} tracked ${tracked === 1 ? 'file' : 'files'}` : null,
    untracked > 0
      ? `permanently delete ${untracked} untracked ${untracked === 1 ? 'file' : 'files'}`
      : null,
  ].filter((effect): effect is string => effect != null)

  return {
    title: `Discard ${scope}?`,
    message: `This will ${effects.join(' and ')}. This cannot be undone.`,
    confirmLabel: untracked === changes.length ? 'Delete files' : 'Discard changes',
  }
}

export const CHANGE_TREE_VIRTUALIZATION_THRESHOLD = 8

function mutationPaths(changes: readonly TreeFile[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath == null ? [change.path] : [change.oldPath, change.path],
      ),
    ),
  ]
}

export function SourceControl({
  snapshot,
  commitMessage,
  setCommitMessage,
  amend,
  setAmend,
  changedPathCount,
  workflowOpen,
  onWorkflowOpenChange: setWorkflowOpen,
  changesOpen,
  onChangesOpenChange: setChangesOpen,
  stagedOpen,
  onStagedOpenChange: setStagedOpen,
  changesHeader,
  composer,
  workflowPane,
  workflowContent,
  onConfirm: setPendingConfirm,
  onError: setLocalError,
  run,
}: {
  snapshot: NonNullable<ReturnType<typeof useRepository>['snapshot']>
  commitMessage: string
  setCommitMessage: (message: string) => void
  amend: boolean
  setAmend: (amend: boolean) => void
  changedPathCount: number
  workflowOpen: boolean
  onWorkflowOpenChange: (open: boolean) => void
  changesOpen: boolean
  onChangesOpenChange: (open: boolean) => void
  stagedOpen: boolean
  onStagedOpenChange: (open: boolean) => void
  changesHeader: React.RefObject<HTMLButtonElement | null>
  composer: React.RefObject<HTMLTextAreaElement | null>
  workflowPane: React.RefObject<HTMLElement | null>
  workflowContent: React.RefObject<HTMLDivElement | null>
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const repository = useRepository()
  const [operationDialog, setOperationDialog] = useState<OperationDialog>(null)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const workflowRefreshVisible = useLoadingIndicator(repository.loading)
  const headTitle =
    snapshot?.headBranch ??
    (snapshot?.headOid == null ? 'Detached HEAD' : `Detached at ${snapshot.headOid.slice(0, 8)}`)
  const workflowChangedDescription =
    changedPathCount > 0
      ? `${changedPathCount} changed ${changedPathCount === 1 ? 'file' : 'files'}`
      : null
  let workflowCountLabel: string | undefined
  let workflowCountTitle: string | undefined
  if (workflowRefreshVisible) {
    workflowCountLabel = workflowChangedDescription
      ? `${workflowChangedDescription}, refreshing Source Control`
      : 'Refreshing Source Control'
    workflowCountTitle = workflowChangedDescription
      ? `Refreshing Source Control; ${workflowChangedDescription} shown`
      : 'Refreshing Source Control'
  } else if (workflowChangedDescription) {
    workflowCountTitle = workflowChangedDescription
  }
  const workflowCount =
    changedPathCount > 0 || workflowRefreshVisible ? (
      <span className="inline-flex items-center gap-1" aria-label={workflowCountLabel}>
        {changedPathCount > 0 && <span>{changedPathCount}</span>}
        <IconRefresh
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 motion-reduce:animate-none',
            workflowRefreshVisible ? 'animate-spin opacity-60' : 'invisible',
          )}
        />
      </span>
    ) : null
  const stagedSource = useMemo(() => createTreeSource(staged), [staged])
  const unstagedSource = useMemo(() => createTreeSource(unstaged), [unstaged])
  const submitCommit = useCallback(async () => {
    const nextMessage = commitMessage.trim()
    if (nextMessage.length === 0 || repository.busy) return
    const reason = repository.getActionDisabledReason()
    if (reason != null) {
      setLocalError(reason)
      return
    }
    setLocalError(null)
    try {
      await repository.commit(nextMessage, amend)
      setCommitMessage('')
    } catch (error) {
      setLocalError(message(error))
    }
  }, [amend, commitMessage, repository, setCommitMessage, setLocalError])

  const backendDisabledReason = repository.getActionDisabledReason()
  return (
    <>
      <section
        ref={workflowPane}
        data-pane="source-control"
        className="section min-h-0 overflow-hidden md:flex md:flex-col"
      >
        <Header
          level="pane"
          className="border-t-0"
          actions={
            <SourceControlHeaderActions
              onConfirm={setPendingConfirm}
              onError={setLocalError}
              onOpenDialog={setOperationDialog}
              moreTrigger={moreTrigger}
            />
          }
          dataSection="workflow"
          icon={IconSymbolDiffstatFill}
          count={workflowCount}
          countTitle={workflowCountTitle}
          open={workflowOpen}
          title={headTitle}
          onOpenChange={setWorkflowOpen}
        />
        {workflowOpen && (
          <Pane
            ref={workflowContent}
            data-pane-body="source-control"
            className="min-h-0 md:flex md:flex-1 md:flex-col md:overflow-x-hidden max-md:overflow-visible"
          >
            <form
              className="commit-composer shrink-0 px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCommit()
              }}
            >
              <textarea
                ref={composer}
                aria-label="Commit message"
                className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[var(--ring)]"
                disabled={repository.busy}
                placeholder="Commit message"
                spellCheck
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.ctrlKey) {
                    event.preventDefault()
                    void submitCommit()
                  }
                }}
              />
              <div className="mbs-2 flex flex-wrap items-center gap-2">
                <label
                  htmlFor="gitna-amend"
                  className="me-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Switch
                    id="gitna-amend"
                    aria-label="Amend"
                    checked={amend}
                    disabled={repository.busy || snapshot.headOid == null}
                    onCheckedChange={setAmend}
                  />
                  Amend
                </label>
                <Button
                  type="submit"
                  variant="default"
                  size="sm"
                  disabled={
                    repository.busy ||
                    backendDisabledReason != null ||
                    commitMessage.trim().length === 0 ||
                    (staged.length === 0 && (!amend || snapshot.headOid == null))
                  }
                >
                  Commit
                </Button>
              </div>
            </form>

            <Conflicts onError={setLocalError} />

            {staged.length > 0 && (
              <ChangeSection
                changes={staged}
                modelId="gitna-staged-tree"
                onConfirm={setPendingConfirm}
                onRun={run}
                open={stagedOpen}
                scope="staged"
                source={stagedSource}
                title="Staged Changes"
                onOpenChange={setStagedOpen}
              />
            )}
            {unstaged.length > 0 && (
              <ChangeSection
                changes={unstaged}
                headerRef={changesHeader}
                modelId="gitna-unstaged-tree"
                onConfirm={setPendingConfirm}
                onRun={run}
                open={changesOpen}
                scope="unstaged"
                source={unstagedSource}
                title="Changes"
                onOpenChange={setChangesOpen}
              />
            )}
          </Pane>
        )}
      </section>
      {operationDialog != null && (
        <OperationModal
          kind={operationDialog}
          onClose={() => setOperationDialog(null)}
          onConfirm={setPendingConfirm}
          onError={setLocalError}
        />
      )}
    </>
  )
}

interface SourceControlHeaderActionsProps {
  moreTrigger: React.RefObject<HTMLButtonElement | null>
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
  onOpenDialog: (dialog: Exclude<OperationDialog, null>) => void
}

function SourceControlHeaderActions({
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

function BranchPicker({
  onConfirm,
  onError,
  run,
}: {
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const repository = useRepository()
  const disabledReason = repository.getActionDisabledReason()
  const [branchQuery, setBranchQuery] = useState('')
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const branchMenuContent = useRef<HTMLDivElement>(null)
  const branchMenuTriggers = useRef(new Map<string, HTMLDivElement>())
  const [branchSubmenuOffset, setBranchSubmenuOffset] = useState(0)
  const normalizedBranchQuery = branchQuery.trim().toLocaleLowerCase()
  const localBranches = repository.branches.filter(
    (branch) => !branch.remote && branch.name.toLocaleLowerCase().includes(normalizedBranchQuery),
  )
  const remoteBranches = repository.branches.filter(
    (branch) => branch.remote && branch.name.toLocaleLowerCase().includes(normalizedBranchQuery),
  )

  const deleteBranch = useCallback(
    async (branch: string) => {
      onError(null)
      try {
        await repository.deleteBranch(branch)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'branch-not-merged') {
          onConfirm({
            title: `Delete branch ${branch}?`,
            message:
              'The branch is not fully merged. Deleting it discards commits only reachable from it.',
            confirmLabel: 'Delete anyway',
            run: () => repository.deleteBranch(branch, true),
          })
          return
        }
        onError(message(error))
      }
    },
    [onConfirm, onError, repository],
  )

  return (
    <DropdownMenu
      open={branchMenuOpen}
      onOpenChange={(open) => {
        setBranchMenuOpen(open)
        if (open) void repository.refreshBranches()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-only"
          aria-label={`Switch branch · ${repository.snapshot?.headBranch ?? 'detached'}`}
          title={`Switch branch · ${repository.snapshot?.headBranch ?? 'detached'}`}
          className={CHROME_ICON_BUTTON_CLASS}
        >
          <IconBranch className="size-4 md:size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={branchMenuContent} align="start" className="w-72 p-2">
        <form
          className="mb-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const name = branchQuery.trim()
            if (name.length === 0 || disabledReason != null) return
            setBranchQuery('')
            setBranchMenuOpen(false)
            void run(() => repository.createBranch(name))
          }}
        >
          <Input
            inputSize="sm"
            aria-label="Search or create branch"
            placeholder="Search or create branch"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.currentTarget.value)}
          />
          <Button
            variant="outline"
            size="sm"
            type="submit"
            disabled={branchQuery.trim() === '' || disabledReason != null}
            title={disabledReason ?? undefined}
          >
            New
          </Button>
        </form>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Local branches
        </p>
        <TooltipProvider delayDuration={400} skipDelayDuration={150}>
          {localBranches.map((branch) =>
            branch.current ? (
              <DropdownMenuItem key={branch.name} disabled>
                <span className="w-4" />
                <span className="min-w-0 flex-1 wrap-anywhere font-medium">{branch.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  Current
                  {branch.upstream != null && (
                    <>
                      {' · '}
                      {branch.upstream}
                      {branch.ahead > 0 ? ` ↑${branch.ahead}` : ''}
                      {branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                    </>
                  )}
                </span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSub
                key={branch.name}
                onOpenChange={(open) => {
                  if (!open || branchMenuContent.current == null) return
                  const bounds = branchMenuContent.current.getBoundingClientRect()
                  const viewportWidth = document.documentElement.clientWidth
                  const availableWidth = Math.max(bounds.left, viewportWidth - bounds.right)
                  const triggerWidth = branchMenuTriggers.current.get(branch.name)?.offsetWidth ?? 0
                  setBranchSubmenuOffset(
                    availableWidth < bounds.width ? -(triggerWidth + bounds.width) / 2 : 0,
                  )
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuSubTrigger
                      ref={(element) => {
                        if (element == null) branchMenuTriggers.current.delete(branch.name)
                        else branchMenuTriggers.current.set(branch.name, element)
                      }}
                      onPointerLeave={(event) => {
                        // Overlapping content invalidates Radix's sideways pointer-grace area.
                        if (branchSubmenuOffset < 0) event.preventDefault()
                      }}
                      disabled={repository.busy || disabledReason != null}
                    >
                      <span className="w-4" />
                      <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                      {branch.upstream != null && (
                        <span className="text-[11px] text-muted-foreground">
                          {branch.ahead > 0 ? `↑${branch.ahead}` : ''}
                          {branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                        </span>
                      )}
                    </DropdownMenuSubTrigger>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] wrap-anywhere">
                    {branch.name}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuSubContent
                  sideOffset={branchSubmenuOffset}
                  collisionPadding={8}
                  className="w-72 max-w-[min(18rem,var(--radix-dropdown-menu-content-available-width))]"
                >
                  <p className="px-2 py-1.5 text-xs wrap-anywhere text-muted-foreground">
                    {branch.name}
                  </p>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={disabledReason != null}
                    onSelect={() => void run(() => repository.switchBranch(branch.name))}
                  >
                    Switch to branch
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => void deleteBranch(branch.name)}
                  >
                    Delete branch…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ),
          )}
          {remoteBranches.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Remote branches
              </p>
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                Select a remote branch to check it out locally.
              </p>
              {remoteBranches.map((branch) => {
                const localName = branch.name.slice(branch.name.indexOf('/') + 1)
                return (
                  <Tooltip key={branch.name}>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        aria-label={`Checkout ${branch.name} as ${localName}`}
                        disabled={repository.busy || disabledReason != null}
                        onSelect={() =>
                          void run(() => repository.createBranch(localName, branch.name))
                        }
                      >
                        <span className="w-4" />
                        <span className="min-w-0 flex-1 wrap-anywhere">{branch.name}</span>
                        <span className="min-w-0 flex-1 wrap-anywhere text-[11px] text-muted-foreground">
                          Checkout as {localName}
                        </span>
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] wrap-anywhere">
                      {branch.name}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </>
          )}
          {localBranches.length === 0 && remoteBranches.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No matching branches</p>
          )}
        </TooltipProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChangeContextMenu({
  canOpen,
  canReveal,
  context,
  path,
  directory,
  onOpen,
  onReveal,
}: {
  canOpen: boolean
  canReveal: boolean
  context: ContextMenuOpenContext
  path: string
  directory: boolean
  onOpen: (path: string) => void
  onReveal: (path: string) => void
}) {
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) context.close()
      }}
    >
      <FileTreeContextMenuTrigger context={context} />
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={context.anchorRect.width === 0 && context.anchorRect.height === 0 ? 0 : -2}
        className="min-w-44"
        data-file-tree-context-menu-root="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          context.restoreFocus()
        }}
      >
        {!directory && (
          <DropdownMenuItem
            disabled={!canOpen}
            onSelect={() => {
              context.close()
              onOpen(path)
            }}
          >
            Open in Explorer
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!canReveal}
          onSelect={() => {
            context.close()
            onReveal(path)
          }}
        >
          Reveal in File Manager
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ChangeSectionProps {
  changes: readonly TreeFile[]
  headerRef?: React.Ref<HTMLButtonElement>
  modelId: string
  onConfirm: (confirm: PendingConfirm) => void
  onOpenChange: (open: boolean) => void
  onRun: (action: () => Promise<void>) => Promise<void>
  open: boolean
  scope: ChangeScope
  source: FileTreeSource
  title: string
}

function ChangeSection({
  changes,
  headerRef,
  modelId,
  onConfirm,
  onOpenChange,
  onRun,
  open,
  scope,
  source,
  title,
}: ChangeSectionProps) {
  const repository = useRepository()
  const changesByPath = useMemo(
    () => new Map(changes.map((change) => [change.path, change])),
    [changes],
  )
  const disabledReason = repository.getActionDisabledReason()
  const selectedPath =
    repository.selection?.scope === scope ? repository.selection.change.path : null
  const discardChanges = useCallback(
    async (targetChanges: readonly TreeFile[]) => {
      const tracked = targetChanges.filter((change) => change.kind !== 'untracked')
      const untracked = targetChanges.filter((change) => change.kind === 'untracked')
      if (tracked.length > 0) {
        await repository.mutate({ op: 'discard', paths: mutationPaths(tracked) })
      }
      if (untracked.length > 0) {
        await repository.mutate({ op: 'delete', paths: mutationPaths(untracked) })
      }
    },
    [repository],
  )
  const renderContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const path = trimDirectoryPath(item.path)
      return (
        <ChangeContextMenu
          canOpen={repository.canOpenRepositoryFile(path)}
          canReveal={
            repository.getActionDisabledReason() == null && repository.canRevealPath(item.path)
          }
          context={context}
          path={path}
          directory={item.kind !== 'file'}
          onOpen={(nextPath) => void onRun(() => repository.openRepositoryFile(nextPath, true))}
          onReveal={(nextPath) => void onRun(() => repository.revealPath(nextPath))}
        />
      )
    },
    [onRun, repository],
  )
  const renderRowActions = useCallback<NonNullable<FileTreeOptions['renderRowActions']>>(
    ({ item, row }) => {
      const itemPath = item.path.replace(/[\\/]+$/, '')
      const itemChanges =
        row.kind === 'file'
          ? [changesByPath.get(itemPath)].filter((change): change is TreeFile => change != null)
          : changes.filter((change) => change.path.startsWith(`${itemPath}/`))
      if (itemChanges.length === 0) return null
      const disabledSuffix = disabledReason == null ? '' : ` — ${disabledReason}`
      if (scope === 'staged') {
        return [
          {
            id: 'unstage',
            label: `Unstage ${item.name}${disabledSuffix}`,
            icon: { name: 'gitna-action-unstage' },
            disabled: repository.busy || disabledReason != null,
            onAction: () =>
              void onRun(() =>
                repository.mutate({ op: 'unstage', paths: mutationPaths(itemChanges) }),
              ),
          },
        ]
      }
      return [
        {
          id: 'discard',
          label: `Discard changes in ${item.name}${disabledSuffix}`,
          icon: { name: 'gitna-action-discard' },
          disabled: repository.busy || disabledReason != null,
          onAction: () =>
            onConfirm({
              ...discardConfirmationCopy(item.name, itemChanges, row.kind === 'directory'),
              run: () => discardChanges(itemChanges),
            }),
        },
        {
          id: 'stage',
          label: `Stage ${item.name}${disabledSuffix}`,
          icon: { name: 'gitna-action-stage' },
          disabled: repository.busy || disabledReason != null,
          onAction: () =>
            void onRun(() => repository.mutate({ op: 'stage', paths: mutationPaths(itemChanges) })),
        },
      ]
    },
    [
      changes,
      changesByPath,
      discardChanges,
      disabledReason,
      onConfirm,
      onRun,
      repository,
      repository.busy,
      scope,
    ],
  )

  const headerActions =
    scope === 'staged' ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-only"
        aria-label="Unstage all changes"
        disabled={repository.busy || disabledReason != null}
        title={disabledReason ?? 'Unstage All Changes'}
        onClick={() =>
          void onRun(() => repository.mutate({ op: 'unstage', paths: mutationPaths(changes) }))
        }
      >
        <IconMinus className="size-3" />
      </Button>
    ) : (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon-only"
          aria-label="Discard all changes"
          disabled={repository.busy || disabledReason != null}
          title={disabledReason ?? 'Discard All Changes'}
          onClick={() =>
            onConfirm({
              ...discardConfirmationCopy(null, changes, true),
              run: () => discardChanges(changes),
            })
          }
        >
          <IconReply className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-only"
          aria-label="Stage all changes"
          disabled={repository.busy || disabledReason != null}
          title={disabledReason ?? 'Stage All Changes'}
          onClick={() =>
            void onRun(() => repository.mutate({ op: 'stage', paths: mutationPaths(changes) }))
          }
        >
          <IconPlus className="size-3" />
        </Button>
      </>
    )

  return (
    <TreeSection
      fill={source.pathCount > CHANGE_TREE_VIRTUALIZATION_THRESHOLD}
      dataSection={scope === 'staged' ? 'staged' : 'changes'}
      emptyMessage={changes.length === 0 ? 'No changes' : 'No matching files'}
      headerActions={headerActions}
      headerRef={headerRef}
      icon={IconSymbolDiffstatFill}
      modelId={modelId}
      open={open}
      renderContextMenu={renderContextMenu}
      renderRowActions={renderRowActions}
      selectedPath={selectedPath}
      source={source}
      title={title}
      onOpenChange={onOpenChange}
      onSelectPath={(path) => repository.select(scope, path)}
    />
  )
}

function Conflicts({ onError }: { onError: (error: string | null) => void }) {
  const repository = useRepository()
  const operation = repository.snapshot?.operation
  if (
    operation !== 'merge' &&
    operation !== 'rebase' &&
    operation !== 'cherry-pick' &&
    operation !== 'revert'
  )
    return null
  const disabledReason = repository.getActionDisabledReason()
  const labels: Record<string, string> = {
    merge: 'Merge in progress',
    rebase: 'Rebase in progress',
    'cherry-pick': 'Cherry-pick in progress',
    revert: 'Revert in progress',
  }
  const run = async (request: Parameters<typeof repository.operation>[0]) => {
    if (disabledReason != null) {
      onError(disabledReason)
      return
    }
    onError(null)
    try {
      await repository.operation(request)
    } catch (error) {
      onError(message(error))
    }
  }
  const unresolved = repository.conflicts.length
  return (
    <section className="conflict-bar mb-2 rounded-lg border border-warning/40 bg-warning/5 p-2">
      <div className="mb-2 flex items-center gap-2">
        <strong className="min-w-0 flex-1 text-xs">{labels[operation]}</strong>
        <span className="text-[11px] text-muted-foreground">{unresolved} unresolved</span>
      </div>
      {repository.conflicts.map((conflict: ConflictEntry) => (
        <div key={conflict.path} className="mb-1 flex items-center gap-1 text-xs">
          <span className="min-w-0 flex-1 truncate" title={conflict.path}>
            {conflict.path}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            onClick={() => void run({ op: 'resolve-ours', paths: [conflict.path] })}
          >
            Ours
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            onClick={() => void run({ op: 'resolve-theirs', paths: [conflict.path] })}
          >
            Theirs
          </Button>
          {conflict.canResolveBoth && (
            <Button
              size="xs"
              variant="outline"
              disabled={disabledReason != null}
              title={disabledReason ?? undefined}
              onClick={() => void run({ op: 'resolve-both', paths: [conflict.path] })}
            >
              Both
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            onClick={() =>
              void repository
                .mutate({ op: 'stage', paths: [conflict.path] })
                .catch((error) => onError(message(error)))
            }
          >
            Stage edited
          </Button>
        </div>
      ))}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabledReason != null}
          title={disabledReason ?? undefined}
          onClick={() => void run({ op: `${operation}-abort` as 'merge-abort' })}
        >
          Abort
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={unresolved > 0 || disabledReason != null}
          title={disabledReason ?? undefined}
          onClick={() => void run({ op: `${operation}-continue` as 'merge-continue' })}
        >
          Continue
        </Button>
      </div>
    </section>
  )
}

interface OperationModalProps {
  kind: Exclude<OperationDialog, null>
  onClose: () => void
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
}

function OperationModal({ kind, onClose, onConfirm, onError }: OperationModalProps) {
  const repository = useRepository()
  const [from, setFrom] = useState('HEAD')
  const [to, setTo] = useState('HEAD')
  const [target, setTarget] = useState('')
  const [stashMessage, setStashMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [tagName, setTagName] = useState('')
  const [tagMessage, setTagMessage] = useState('')
  const [tagTarget, setTagTarget] = useState('HEAD')
  const [remote, setRemote] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const disabledReason = repository.getActionDisabledReason()

  useEffect(() => {
    if (repository.remotes.includes(remote)) return
    setRemote(repository.remotes[0] ?? '')
  }, [remote, repository.remotes])

  useEffect(() => {
    if (kind === 'stash') void repository.refreshStashes()
    if (kind === 'tags' || kind === 'compare') void repository.refreshTags()
    if (kind === 'integrate' || kind === 'tags' || kind === 'compare')
      void repository.refreshBranches()
  }, [kind, repository])

  const run = async (action: () => Promise<void>) => {
    if (disabledReason != null) {
      onError(disabledReason)
      return
    }
    setDialogError(null)
    onError(null)
    try {
      await action()
    } catch (error) {
      if (mounted.current) setDialogError(message(error))
    }
  }
  const referenceStatus = (
    <ReadStatus
      loading={repository.branchesLoading || repository.tagsLoading}
      error={repository.branchesError ?? repository.tagsError}
      onRetry={() => {
        void repository.refreshBranches()
        void repository.refreshTags()
      }}
    />
  )
  const refs = [
    'HEAD',
    ...repository.branches.map((branch) => branch.name),
    ...repository.tags.map((tag) => tag.name),
  ]

  if (kind === 'compare') {
    return (
      <Modal title="Compare references" onClose={onClose}>
        {referenceStatus}
        <div className="grid gap-3">
          <SelectField label="From" value={from} values={refs} onChange={setFrom} />
          <SelectField label="To" value={to} values={refs} onChange={setTo} />
          <Button
            variant="outline"
            size="sm"
            disabled={from === to || repository.compareLoading}
            onClick={() => void repository.openCompare(from, to, `${from}..${to}`)}
          >
            Compare
          </Button>
          <ReadStatus
            operation={`${from}\u0000${to}`}
            loading={repository.compareLoading}
            error={repository.compareError}
            onRetry={() => void repository.openCompare(from, to, `${from}..${to}`)}
          />
          {repository.compare != null &&
            !repository.compareLoading &&
            repository.compareError == null && (
              <p className="text-xs text-muted-foreground">
                {repository.compare.label} · {repository.compareFiles.length} changed files loaded
                in the review surface.
              </p>
            )}
        </div>
      </Modal>
    )
  }
  if (kind === 'integrate') {
    const branches = repository.branches
      .filter((branch) => !branch.current)
      .map((branch) => branch.name)
    return (
      <Modal
        title="Merge or rebase"
        error={dialogError}
        disabledReason={disabledReason}
        onClose={onClose}
      >
        <ReadStatus
          loading={repository.branchesLoading}
          error={repository.branchesError}
          onRetry={() => void repository.refreshBranches()}
        />
        <div className="grid gap-3">
          <SelectField
            label="Branch or reference"
            value={target}
            values={branches}
            onChange={setTarget}
            placeholder="Select a branch"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Merge preserves both histories. Rebase reapplies the current branch on top of the
            selected reference.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!target || disabledReason != null}
              onClick={() =>
                void run(async () => {
                  await repository.operation({ op: 'merge', name: target })
                  onClose()
                })
              }
            >
              Merge
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!target || disabledReason != null}
              onClick={() =>
                void run(async () => {
                  await repository.operation({ op: 'rebase', name: target })
                  onClose()
                })
              }
            >
              Rebase
            </Button>
          </div>
        </div>
      </Modal>
    )
  }
  if (kind === 'stash') {
    return (
      <Modal title="Stashes" error={dialogError} disabledReason={disabledReason} onClose={onClose}>
        <ReadStatus
          loading={repository.stashesLoading}
          error={repository.stashesError}
          onRetry={() => void repository.refreshStashes()}
        />
        <form
          className="mb-4 grid gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            const value = stashMessage.trim()
            if (!value) return
            void run(async () => {
              await repository.operation({ op: 'stash-push', message: value, includeUntracked })
              setStashMessage('')
            })
          }}
        >
          <Input
            aria-label="Stash message"
            placeholder="Stash message"
            value={stashMessage}
            onChange={(event) => setStashMessage(event.currentTarget.value)}
          />
          <label
            htmlFor="gitna-stash-include-untracked"
            className="flex cursor-pointer items-center gap-2 text-xs"
          >
            <Switch
              id="gitna-stash-include-untracked"
              aria-label="Include untracked"
              checked={includeUntracked}
              onCheckedChange={setIncludeUntracked}
            />
            Include untracked
          </label>
          <Button
            variant="outline"
            size="sm"
            type="submit"
            disabled={disabledReason != null}
            title={disabledReason ?? 'Create stash'}
          >
            Stash
          </Button>
        </form>
        <div className="grid gap-1">
          {repository.stashes.map((stash) => (
            <div
              key={stash.ref}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">
                <b>{stash.ref}</b> {stash.branch}: {stash.message}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabledReason != null}
                title={disabledReason ?? 'Apply stash'}
                onClick={() =>
                  void run(() => repository.operation({ op: 'stash-apply', ref: stash.ref }))
                }
              >
                Apply
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabledReason != null}
                title={disabledReason ?? 'Pop stash'}
                onClick={() =>
                  void run(() => repository.operation({ op: 'stash-pop', ref: stash.ref }))
                }
              >
                Pop
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabledReason != null}
                title={disabledReason ?? 'Drop stash'}
                onClick={() =>
                  onConfirm({
                    title: `Drop ${stash.ref}?`,
                    message: 'This permanently removes the stash. Gitna cannot undo this action.',
                    confirmLabel: 'Drop stash',
                    run: () => repository.operation({ op: 'stash-drop', ref: stash.ref }),
                  })
                }
              >
                Drop
              </Button>
            </div>
          ))}
          {repository.stashes.length === 0 &&
            !repository.stashesLoading &&
            repository.stashesError == null && (
              <p className="text-xs text-muted-foreground">No stashes</p>
            )}
        </div>
      </Modal>
    )
  }
  return (
    <Modal title="Tags" error={dialogError} disabledReason={disabledReason} onClose={onClose}>
      {referenceStatus}
      <form
        className="mb-4 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const name = tagName.trim()
          if (!name) return
          void run(async () => {
            await repository.operation({
              op: 'create-tag',
              name,
              start: tagTarget === 'HEAD' ? undefined : tagTarget,
              message: tagMessage.trim(),
            })
            setTagName('')
          })
        }}
      >
        <Input
          aria-label="New tag name"
          placeholder="Tag name"
          value={tagName}
          onChange={(event) => setTagName(event.currentTarget.value)}
        />
        <SelectField label="Target" value={tagTarget} values={refs} onChange={setTagTarget} />
        <Input
          aria-label="Annotated tag message"
          placeholder="Message (optional)"
          value={tagMessage}
          onChange={(event) => setTagMessage(event.currentTarget.value)}
        />
        <Button
          variant="outline"
          size="sm"
          type="submit"
          disabled={disabledReason != null}
          title={disabledReason ?? 'Create tag'}
        >
          Create
        </Button>
      </form>
      <label htmlFor="gitna-tag-remote" className="mb-3 grid gap-1 text-xs">
        Push to
        <select
          id="gitna-tag-remote"
          aria-label="Push to"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          disabled={repository.remotes.length === 0}
          value={remote}
          onChange={(event) => setRemote(event.currentTarget.value)}
        >
          {repository.remotes.length === 0 && <option value="">No remotes configured</option>}
          {repository.remotes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <div className="grid gap-1">
        {repository.tags.map((tag) => (
          <div
            key={tag.name}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">
              <b>{tag.name}</b>
              {tag.annotated ? ' (annotated)' : ''}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={remote === '' || disabledReason != null}
              title={disabledReason ?? (remote === '' ? 'Select a remote' : 'Push tag')}
              onClick={() =>
                void run(() => repository.operation({ op: 'push-tag', remote, name: tag.name }))
              }
            >
              Push
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabledReason != null}
              title={disabledReason ?? 'Delete tag'}
              onClick={() =>
                onConfirm({
                  title: `Delete tag ${tag.name}?`,
                  message: 'This removes the local tag reference. Gitna cannot undo the deletion.',
                  confirmLabel: 'Delete tag',
                  run: () => repository.operation({ op: 'delete-tag', name: tag.name }),
                })
              }
            >
              Delete
            </Button>
          </div>
        ))}
        {repository.tags.length === 0 &&
          !repository.tagsLoading &&
          repository.tagsError == null && <p className="text-xs text-muted-foreground">No tags</p>}
      </div>
    </Modal>
  )
}

function ReadStatus({
  loading,
  error,
  onRetry,
  operation,
}: {
  loading: boolean
  error: string | null
  onRetry: () => void
  operation?: unknown
}) {
  const loadingVisible = useLoadingIndicator(loading && error == null, operation)
  if (error == null)
    return (
      <p className="mb-3 min-h-4 text-xs text-muted-foreground" role="status">
        {loadingVisible && 'Loading… Previous results may remain visible.'}
      </p>
    )
  return (
    <div className="mb-3 text-xs" role="alert">
      <p>{error} Previous results may remain visible.</p>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function SelectField({
  label,
  onChange,
  placeholder,
  value,
  values,
}: {
  label: string
  onChange: (value: string) => void
  placeholder?: string
  value: string
  values: string[]
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span>{label}</span>
      <select
        aria-label={label === 'Branch or reference' ? label : `Compare ${label.toLowerCase()}`}
        className="h-9 cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-[var(--ring)]"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {placeholder != null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}
