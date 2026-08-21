import {
  IconBranch,
  IconChevronSm,
  IconEllipsis,
  IconFileTree,
  IconRefresh,
  IconSearch,
  IconSymbolDiffstatFill,
} from '@pierre/icons'
import type { FileTree, GitStatus, GitStatusEntry } from '@pierre/trees'
import { useFileTreeSearch } from '@pierre/trees/react'
import {
  Fragment,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ApiError } from '../../lib/api'
import type { ChangeKind, ChangeScope, ConflictEntry } from '../../lib/types'
import { Button } from '../components/Button'
import { DiffsHubFileTree } from '../components/DiffsHubFileTree'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Input } from '../components/Input'
import { cn } from '../lib/cn'
import type { DiffsHubFileTreeSource } from '../lib/types'
import { Confirm, Modal } from './Modal'
import { useRepository } from './repository'

interface PendingConfirm {
  confirmLabel: string
  message: string
  run(): Promise<void>
  title: string
}

type OperationDialog = 'compare' | 'integrate' | 'stash' | 'tags' | null

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface TreeFile {
  kind: ChangeKind
  path: string
}

function gitStatus(kind: ChangeKind): GitStatus {
  if (kind === 'added' || kind === 'untracked') return 'added'
  if (kind === 'deleted') return 'deleted'
  if (kind === 'renamed') return 'renamed'
  return 'modified'
}

function createTreeSource(files: readonly TreeFile[]): DiffsHubFileTreeSource {
  const byPath = new Map<string, TreeFile>()
  for (const file of files) byPath.set(file.path, file)
  const paths = [...byPath.keys()]
  const statuses: GitStatusEntry[] = paths.map((path) => ({
    path,
    status: gitStatus(byPath.get(path)!.kind),
  }))
  return {
    gitStatus: statuses,
    pathCount: paths.length,
    paths,
    pathToItemId: new Map(paths.map((path) => [path, path])),
  }
}

function treeViewportHeight(source: DiffsHubFileTreeSource, maximum = 240): number {
  if (source.pathCount === 0) return 0
  const directories = new Set<string>()
  for (const path of source.paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  return Math.min(maximum, Math.max(48, (source.pathCount + directories.size) * 24 + 8))
}

function ignoreTreeModel(_model: FileTree | null): void {}

export function GitnaSourceControl() {
  const repository = useRepository()
  const [repositoryOpen, setRepositoryOpen] = useState(true)
  const [workflowOpen, setWorkflowOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [graphOpen, setGraphOpen] = useState(true)
  const [commitMessage, setCommitMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [operationDialog, setOperationDialog] = useState<OperationDialog>(null)
  const changesHeader = useRef<HTMLButtonElement>(null)
  const graphHeader = useRef<HTMLButtonElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const moreTrigger = useRef<HTMLButtonElement>(null)

  const snapshot = repository.snapshot
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const repositorySource = useMemo(
    () => createTreeSource([...staged, ...unstaged]),
    [staged, unstaged],
  )
  const stagedSource = useMemo(() => createTreeSource(staged), [staged])
  const unstagedSource = useMemo(() => createTreeSource(unstaged), [unstaged])

  const run = useCallback(async (action: () => Promise<void>) => {
    setLocalError(null)
    try {
      await action()
    } catch (error) {
      setLocalError(message(error))
    }
  }, [])

  const submitCommit = useCallback(async () => {
    const nextMessage = commitMessage.trim()
    if (nextMessage.length === 0 || repository.busy) return
    setLocalError(null)
    try {
      await repository.commit(nextMessage, amend)
      setCommitMessage('')
    } catch (error) {
      setLocalError(message(error))
    }
  }, [amend, commitMessage, repository])

  const selectRepositoryPath = useCallback(
    (path: string) => {
      const scope = unstaged.some((change) => change.path === path) ? 'unstaged' : 'staged'
      repository.select(scope, path)
    },
    [repository, unstaged],
  )

  useEffect(() => {
    if (window.matchMedia('(max-width: 767px)').matches) setGraphOpen(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F6') {
        event.preventDefault()
        if (event.shiftKey) {
          setGraphOpen(true)
          queueMicrotask(() => graphHeader.current?.focus())
        } else {
          setWorkflowOpen(true)
          setChangesOpen(true)
          queueMicrotask(() => changesHeader.current?.focus())
        }
      } else if (event.key.toLowerCase() === 'c' && event.ctrlKey && event.shiftKey) {
        event.preventDefault()
        setWorkflowOpen(true)
        queueMicrotask(() => composer.current?.focus())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (snapshot == null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
        {repository.error ?? 'Loading repository…'}
      </div>
    )
  }

  return (
    <section
      className="source-control flex h-full min-h-0 flex-col"
      aria-label="Source Control workflow"
    >
      <div className="workflow-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        <TreeSection
          dataSection="repository"
          emptyMessage="No repository changes"
          icon={<IconFileTree className="size-3" />}
          maximumHeight={144}
          modelId="gitna-repository-tree"
          open={repositoryOpen}
          selectedPath={repository.selection?.change.path}
          source={repositorySource}
          title="Repository"
          onOpenChange={setRepositoryOpen}
          onSelectPath={selectRepositoryPath}
        />

        <section className="section border-t border-border/70">
          <WorkflowSectionHeader
            dataSection="workflow"
            icon={<IconSymbolDiffstatFill className="size-3" />}
            open={workflowOpen}
            title="Changes"
            onOpenChange={setWorkflowOpen}
          />
          {workflowOpen && (
            <>
              <SourceControlToolbar
                onConfirm={setPendingConfirm}
                onError={setLocalError}
                onOpenDialog={setOperationDialog}
                moreTrigger={moreTrigger}
              />
              <form
                className="commit-composer px-3 py-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submitCommit()
                }}
              >
                <textarea
                  ref={composer}
                  aria-label="Commit message"
                  className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[var(--diffshub-primary-fg)]"
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
                <div className="mt-2 flex items-center gap-2">
                  <label className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={amend}
                      onChange={(event) => setAmend(event.currentTarget.checked)}
                    />
                    Amend
                  </label>
                  <Button
                    type="submit"
                    variant="default"
                    size="sm"
                    disabled={
                      repository.busy || commitMessage.trim().length === 0 || staged.length === 0
                    }
                  >
                    Commit
                  </Button>
                </div>
              </form>

              <ConflictPanel onError={setLocalError} />

              {staged.length > 0 && (
                <ChangeSection
                  changes={staged}
                  modelId="gitna-staged-tree"
                  open={stagedOpen}
                  scope="staged"
                  source={stagedSource}
                  title="Staged Changes"
                  onOpenChange={setStagedOpen}
                />
              )}
              <ChangeSection
                changes={unstaged}
                headerRef={changesHeader}
                modelId="gitna-unstaged-tree"
                open={changesOpen}
                scope="unstaged"
                source={unstagedSource}
                title="Changes"
                onOpenChange={setChangesOpen}
              />
            </>
          )}
        </section>

        <GraphSection
          headerRef={graphHeader}
          open={graphOpen}
          onConfirm={setPendingConfirm}
          onOpenChange={setGraphOpen}
        />
      </div>

      {(localError ?? repository.mutationError) != null && (
        <p
          className="mx-3 mb-3 rounded-md bg-red-500/10 px-2.5 py-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
        >
          {localError ?? repository.mutationError}
        </p>
      )}

      {operationDialog != null && (
        <OperationModal
          kind={operationDialog}
          onClose={() => setOperationDialog(null)}
          onConfirm={setPendingConfirm}
          onError={setLocalError}
        />
      )}
      {pendingConfirm != null && (
        <Confirm
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const pending = pendingConfirm
            setPendingConfirm(null)
            void run(pending.run)
          }}
        />
      )}
    </section>
  )
}

interface ToolbarProps {
  moreTrigger: React.RefObject<HTMLButtonElement | null>
  onConfirm(confirm: PendingConfirm): void
  onError(error: string | null): void
  onOpenDialog(dialog: Exclude<OperationDialog, null>): void
}

function SourceControlToolbar({ moreTrigger, onConfirm, onError, onOpenDialog }: ToolbarProps) {
  const repository = useRepository()
  const [newBranchName, setNewBranchName] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [publishBranch, setPublishBranch] = useState<string | null>(null)
  const [publishRemote, setPublishRemote] = useState('origin')
  const localBranches = repository.branches.filter((branch) => !branch.remote)
  const remotes = useMemo(() => {
    const values = new Set<string>()
    for (const branch of repository.branches) {
      if (!branch.remote) continue
      const slash = branch.name.indexOf('/')
      if (slash > 0) values.add(branch.name.slice(0, slash))
    }
    return [...values].sort()
  }, [repository.branches])

  const run = useCallback(
    async (action: () => Promise<void>) => {
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

  const push = useCallback(async () => {
    onError(null)
    try {
      await repository.operation({ op: 'push' })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no-upstream') {
        setPublishBranch(error.branch ?? repository.snapshot?.headBranch ?? null)
        if (remotes[0] != null) setPublishRemote(remotes[0])
      } else {
        onError(message(error))
      }
    }
  }, [onError, remotes, repository])

  return (
    <>
      <div className="toolbar flex h-8 shrink-0 items-center gap-1 border-b border-border px-3">
        <DropdownMenu onOpenChange={(open) => open && void repository.refreshBranches()}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-only"
              aria-label={`Switch branch · ${repository.snapshot?.headBranch ?? 'detached'}`}
              title={`Switch branch · ${repository.snapshot?.root ?? ''}`}
            >
              <IconBranch className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 p-2">
            <form
              className="mb-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                const name = newBranchName.trim()
                if (name.length === 0) return
                setNewBranchName('')
                void run(() => repository.operation({ op: 'create-branch', name }))
              }}
            >
              <Input
                inputSize="sm"
                aria-label="New branch name"
                placeholder="New branch name"
                value={newBranchName}
                onChange={(event) => setNewBranchName(event.currentTarget.value)}
              />
              <Button variant="outline" size="sm" type="submit">
                New
              </Button>
            </form>
            <DropdownMenuSeparator />
            {localBranches.map((branch) => (
              <Fragment key={branch.name}>
                <DropdownMenuItem
                  disabled={branch.current || repository.busy}
                  onSelect={() =>
                    void run(() => repository.operation({ op: 'switch-branch', name: branch.name }))
                  }
                >
                  <span className="w-4">{branch.current ? '●' : ''}</span>
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.upstream != null && (
                    <span className="text-[10px] text-muted-foreground">
                      {branch.ahead > 0 ? `↑${branch.ahead}` : ''}
                      {branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                    </span>
                  )}
                </DropdownMenuItem>
                {!branch.current && (
                  <DropdownMenuItem
                    className="text-red-600 dark:text-red-400"
                    disabled={repository.busy}
                    onSelect={() => void deleteBranch(branch.name)}
                  >
                    Delete branch {branch.name}
                  </DropdownMenuItem>
                )}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {repository.snapshot?.headBranch ?? repository.snapshot?.headOid?.slice(0, 8)}
        </span>
        {repository.activeOpLabel != null && (
          <span
            className="active-op flex items-center gap-1 text-[10px] text-muted-foreground"
            role="status"
          >
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            {repository.activeOpLabel}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-only"
          disabled={repository.busy}
          aria-label="Fetch"
          title="Fetch"
          onClick={() => void run(() => repository.operation({ op: 'fetch' }))}
        >
          <IconRefresh className="size-3.5" />
        </Button>
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
              title="More actions"
            >
              <IconEllipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void run(() => repository.operation({ op: 'pull' }))}>
              Pull
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void push()}>Push</DropdownMenuItem>
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
      </div>
      {publishBranch != null && (
        <div
          className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs"
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">
            <b>{publishBranch}</b> has no upstream
          </span>
          <select
            aria-label="Publish remote"
            className="rounded border border-border bg-background px-1 py-1"
            value={publishRemote}
            onChange={(event) => setPublishRemote(event.currentTarget.value)}
          >
            {(remotes.length > 0 ? remotes : ['origin']).map((remote) => (
              <option key={remote}>{remote}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              void run(async () => {
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
      )}
    </>
  )
}

interface WorkflowSectionHeaderProps {
  className?: string
  count?: number
  dataSection: string
  headerRef?: React.Ref<HTMLButtonElement>
  icon: ReactNode
  onOpenChange(open: boolean): void
  open: boolean
  title: string
}

function WorkflowSectionHeader({
  className,
  count,
  dataSection,
  headerRef,
  icon,
  onOpenChange,
  open,
  title,
}: WorkflowSectionHeaderProps) {
  return (
    <button
      ref={headerRef}
      type="button"
      className={cn(
        'section-header flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--diffshub-primary-fg)]',
        className,
      )}
      data-section={dataSection}
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
    >
      <IconChevronSm className={cn('size-3 transition-transform', !open && '-rotate-90')} />
      {icon}
      <span className="section-title min-w-0 flex-1 truncate font-medium">{title}</span>
      {count != null && (
        <span className="section-count tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  )
}

interface TreeSectionProps {
  dataSection: string
  emptyMessage: string
  headerRef?: React.Ref<HTMLButtonElement>
  icon: ReactNode
  maximumHeight?: number
  modelId: string
  onOpenChange(open: boolean): void
  onSelectPath(path: string): void
  open: boolean
  selectedPath?: string | null
  source: DiffsHubFileTreeSource
  title: string
}

function TreeSection({
  dataSection,
  emptyMessage,
  headerRef,
  icon,
  maximumHeight,
  modelId,
  onOpenChange,
  onSelectPath,
  open,
  selectedPath,
  source,
  title,
}: TreeSectionProps) {
  const [model, setModel] = useState<FileTree | null>(null)
  const height = treeViewportHeight(source, maximumHeight)
  return (
    <section className="section border-t border-border/70 first:border-t-0">
      <div className="flex items-center">
        <WorkflowSectionHeader
          className="flex-1"
          count={source.pathCount}
          dataSection={dataSection}
          headerRef={headerRef}
          icon={icon}
          open={open}
          title={title}
          onOpenChange={onOpenChange}
        />
        {open && model != null && source.pathCount > 0 && (
          <TreeSearchToggle model={model} title={title} />
        )}
      </div>
      {open && source.pathCount > 0 && (
        <div className="min-h-0" style={{ height }}>
          <DiffsHubFileTree
            className="md:ml-2"
            modelId={modelId}
            onModelReady={setModel}
            onSelectItem={onSelectPath}
            selectedPath={selectedPath}
            source={source}
          />
        </div>
      )}
      {open && source.pathCount === 0 && (
        <p className="px-8 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
      )}
    </section>
  )
}

function TreeSearchToggle({ model, title }: { model: FileTree; title: string }) {
  const search = useFileTreeSearch(model)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-only"
      aria-label={search.isOpen ? `Hide ${title} search` : `Search ${title}`}
      aria-pressed={search.isOpen}
      className="mr-2"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => (search.isOpen ? search.close() : search.open())}
    >
      <IconSearch className="size-3" />
    </Button>
  )
}

interface ChangeSectionProps {
  changes: readonly TreeFile[]
  headerRef?: React.Ref<HTMLButtonElement>
  modelId: string
  onOpenChange(open: boolean): void
  open: boolean
  scope: ChangeScope
  source: DiffsHubFileTreeSource
  title: string
}

function ChangeSection({
  changes,
  headerRef,
  modelId,
  onOpenChange,
  open,
  scope,
  source,
  title,
}: ChangeSectionProps) {
  const repository = useRepository()
  const selectedPath =
    repository.selection?.scope === scope ? repository.selection.change.path : null
  return (
    <TreeSection
      dataSection={scope === 'staged' ? 'staged' : 'changes'}
      emptyMessage={changes.length === 0 ? 'No changes' : 'No matching files'}
      headerRef={headerRef}
      icon={<IconSymbolDiffstatFill className="size-3" />}
      modelId={modelId}
      open={open}
      selectedPath={selectedPath}
      source={source}
      title={title}
      onOpenChange={onOpenChange}
      onSelectPath={(path) => repository.select(scope, path)}
    />
  )
}

interface GraphSectionProps {
  headerRef: React.RefObject<HTMLButtonElement | null>
  onConfirm(confirm: PendingConfirm): void
  onOpenChange(open: boolean): void
  open: boolean
}

function GraphSection({ headerRef, onConfirm, onOpenChange, open }: GraphSectionProps) {
  const repository = useRepository()
  return (
    <section className="section border-t border-border/70">
      <WorkflowSectionHeader
        count={repository.graphRows.length}
        dataSection="graph"
        headerRef={headerRef}
        icon={<IconBranch className="size-3" />}
        open={open}
        title="Graph"
        onOpenChange={onOpenChange}
      />
      {open && (
        <div className="graph-list px-2">
          {repository.graphRows.map((row) => (
            <GraphCommitRow key={row.commit.oid} row={row} onConfirm={onConfirm} />
          ))}
          {repository.graphHasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={repository.graphLoading}
              onClick={() => void repository.loadMoreGraph()}
            >
              Load more
            </Button>
          )}
          {repository.graphError != null && (
            <p role="alert" className="px-2 py-2 text-xs text-red-500">
              {repository.graphError}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function GraphCommitRow({
  row,
  onConfirm,
}: {
  row: ReturnType<typeof useRepository>['graphRows'][number]
  onConfirm(confirm: PendingConfirm): void
}) {
  const repository = useRepository()
  const open = repository.expanded[row.commit.oid] === true
  const shortOid = row.commit.oid.slice(0, 8)
  const files = repository.commitFiles[row.commit.oid]
  const source = useMemo(() => createTreeSource(files ?? []), [files])
  const selectedPath =
    repository.commitDiff?.oid === row.commit.oid ? repository.commitDiff.path : null
  return (
    <div className="graph-row border-t border-border/40 first:border-0">
      <div className="group flex min-h-8 items-center gap-1 text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--diffshub-primary-fg)]"
          aria-expanded={open}
          onClick={() => void repository.toggleCommit(row.commit.oid)}
        >
          <span
            className="relative flex h-6 w-5 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            <span className="absolute inset-y-0 left-1/2 w-px bg-blue-400/70" />
            <span className="relative size-2 rounded-full border-2 border-blue-500 bg-background" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{row.commit.subject}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {row.commit.authorName} · {shortOid}
            </span>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-only"
              aria-label={`Actions for ${row.commit.subject}`}
            >
              <IconEllipsis className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => void repository.operation({ op: 'cherry-pick', ref: row.commit.oid })}
            >
              Cherry-pick
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void repository.operation({ op: 'revert', ref: row.commit.oid })}
            >
              Revert
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void repository.operation({ op: 'reset', ref: row.commit.oid, mode: 'soft' })
              }
            >
              Reset soft
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void repository.operation({ op: 'reset', ref: row.commit.oid, mode: 'mixed' })
              }
            >
              Reset mixed
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                onConfirm({
                  title: `Hard reset to ${shortOid}?`,
                  message:
                    'This discards index and working-tree changes. Gitna cannot undo this action.',
                  confirmLabel: 'Hard reset',
                  run: () =>
                    repository.operation({ op: 'reset', ref: row.commit.oid, mode: 'hard' }),
                })
              }
            >
              Reset hard…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="ml-5 border-l border-border/70">
          {repository.filesLoading[row.commit.oid] && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          )}
          {files != null && files.length > 0 && (
            <div className="min-h-0" style={{ height: treeViewportHeight(source, 192) }}>
              <DiffsHubFileTree
                className="md:ml-1"
                modelId={`gitna-graph-${row.commit.oid}`}
                onModelReady={ignoreTreeModel}
                onSelectItem={(path) => {
                  const file = files.find((candidate) => candidate.path === path)
                  if (file != null) {
                    repository.selectCommitFile(row.commit.oid, row.commit.subject, file)
                  }
                }}
                selectedPath={selectedPath}
                source={source}
              />
            </div>
          )}
          {files != null && files.length === 0 && !repository.filesLoading[row.commit.oid] && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No changed files</p>
          )}
          {repository.filesError[row.commit.oid] != null && (
            <p role="alert" className="px-3 py-2 text-xs text-red-500">
              {repository.filesError[row.commit.oid]}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ConflictPanel({ onError }: { onError(error: string | null): void }) {
  const repository = useRepository()
  const operation = repository.snapshot?.operation
  if (
    operation !== 'merge' &&
    operation !== 'rebase' &&
    operation !== 'cherry-pick' &&
    operation !== 'revert'
  )
    return null
  const labels: Record<string, string> = {
    merge: 'Merge in progress',
    rebase: 'Rebase in progress',
    'cherry-pick': 'Cherry-pick in progress',
    revert: 'Revert in progress',
  }
  const run = async (request: Parameters<typeof repository.operation>[0]) => {
    onError(null)
    try {
      await repository.operation(request)
    } catch (error) {
      onError(message(error))
    }
  }
  const unresolved = repository.conflicts.length
  return (
    <section className="conflict-bar mb-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
      <div className="mb-2 flex items-center gap-2">
        <strong className="min-w-0 flex-1 text-xs">{labels[operation]}</strong>
        <span className="text-[10px] text-muted-foreground">{unresolved} unresolved</span>
      </div>
      {repository.conflicts.map((conflict: ConflictEntry) => (
        <div key={conflict.path} className="mb-1 flex items-center gap-1 text-xs">
          <span className="min-w-0 flex-1 truncate" title={conflict.path}>
            {conflict.path}
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void run({ op: 'resolve-ours', paths: [conflict.path] })}
          >
            Ours
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void run({ op: 'resolve-theirs', paths: [conflict.path] })}
          >
            Theirs
          </Button>
          {conflict.canResolveBoth && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void run({ op: 'resolve-both', paths: [conflict.path] })}
            >
              Both
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void repository.mutate({ op: 'stage', paths: [conflict.path] })}
          >
            Stage edited
          </Button>
        </div>
      ))}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => void run({ op: `${operation}-abort` as 'merge-abort' })}
        >
          Abort
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={unresolved > 0}
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
  onClose(): void
  onConfirm(confirm: PendingConfirm): void
  onError(error: string | null): void
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
  const [remote, setRemote] = useState('origin')

  useEffect(() => {
    if (kind === 'stash') void repository.refreshStashes()
    if (kind === 'tags' || kind === 'compare') void repository.refreshTags()
    if (kind === 'integrate' || kind === 'tags' || kind === 'compare')
      void repository.refreshBranches()
  }, [kind, repository])

  const run = async (action: () => Promise<void>) => {
    onError(null)
    try {
      await action()
    } catch (error) {
      onError(message(error))
    }
  }
  const refs = [
    'HEAD',
    ...repository.branches.map((branch) => branch.name),
    ...repository.tags.map((tag) => tag.name),
  ]

  if (kind === 'compare') {
    return (
      <Modal title="Compare references" onClose={onClose}>
        <div className="grid gap-3">
          <SelectField label="From" value={from} values={refs} onChange={setFrom} />
          <SelectField label="To" value={to} values={refs} onChange={setTo} />
          <Button
            variant="outline"
            size="sm"
            disabled={from === to}
            onClick={() => void repository.openCompare(from, to, `${from}..${to}`)}
          >
            Compare
          </Button>
          {repository.compare != null && (
            <p className="text-xs text-muted-foreground">
              {repository.compare.label} · {repository.compareFiles.length} changed files loaded in
              the review surface.
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
      <Modal title="Merge or rebase" onClose={onClose}>
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
              disabled={!target}
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
              disabled={!target}
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
      <Modal title="Stashes" onClose={onClose}>
        <form
          className="mb-4 grid gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            const value = stashMessage.trim()
            if (!value) return
            setStashMessage('')
            void run(() =>
              repository.operation({ op: 'stash-push', message: value, includeUntracked }),
            )
          }}
        >
          <Input
            aria-label="Stash message"
            placeholder="Stash message"
            value={stashMessage}
            onChange={(event) => setStashMessage(event.currentTarget.value)}
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.currentTarget.checked)}
            />
            Include untracked
          </label>
          <Button variant="outline" size="sm" type="submit">
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
                onClick={() =>
                  void run(() => repository.operation({ op: 'stash-apply', ref: stash.ref }))
                }
              >
                Apply
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  void run(() => repository.operation({ op: 'stash-pop', ref: stash.ref }))
                }
              >
                Pop
              </Button>
              <Button
                variant="ghost"
                size="xs"
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
          {repository.stashes.length === 0 && (
            <p className="text-xs text-muted-foreground">No stashes</p>
          )}
        </div>
      </Modal>
    )
  }
  return (
    <Modal title="Tags" onClose={onClose}>
      <form
        className="mb-4 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const name = tagName.trim()
          if (!name) return
          setTagName('')
          void run(() =>
            repository.operation({
              op: 'create-tag',
              name,
              start: tagTarget === 'HEAD' ? undefined : tagTarget,
              message: tagMessage.trim(),
            }),
          )
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
        <Button variant="outline" size="sm" type="submit">
          Create
        </Button>
      </form>
      <label className="mb-3 grid gap-1 text-xs">
        Push to
        <input
          className="rounded border border-border bg-background px-2 py-1"
          value={remote}
          onChange={(event) => setRemote(event.currentTarget.value)}
        />
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
              onClick={() =>
                void run(() => repository.operation({ op: 'push-tag', remote, name: tag.name }))
              }
            >
              Push
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                onConfirm({
                  title: `Delete tag ${tag.name}?`,
                  message:
                    'This removes the local tag reference. Gitna cannot undo the deletion.',
                  confirmLabel: 'Delete tag',
                  run: () => repository.operation({ op: 'delete-tag', name: tag.name }),
                })
              }
            >
              Delete
            </Button>
          </div>
        ))}
        {repository.tags.length === 0 && <p className="text-xs text-muted-foreground">No tags</p>}
      </div>
    </Modal>
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
  onChange(value: string): void
  placeholder?: string
  value: string
  values: string[]
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span>{label}</span>
      <select
        aria-label={label === 'Branch or reference' ? label : `Compare ${label.toLowerCase()}`}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
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
