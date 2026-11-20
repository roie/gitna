import {
  IconBranch,
  IconEllipsis,
  IconFileTree,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconReply,
  IconSymbolDiffstatFill,
} from '@pierre/icons'
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeOptions,
  GitStatus,
} from '@pierre/trees'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { savePreference } from '../../lib/preferences'
import type { ChangeScope, ConflictEntry } from '../../lib/types'
import { Button } from '../components/Button'
import { CHROME_ICON_BUTTON_CLASS } from '../components/chromeButtonStyles'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Input } from '../components/Input'
import { Switch } from '../components/Switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/Tooltip'
import { cn } from '../lib/cn'
import { LoadingIndicator, useLoadingIndicator } from '../lib/loading'
import type { DiffsHubFileTreeSource } from '../lib/types'
import { Confirm, Modal } from './Modal'
import { EntryDialog } from './EntryDialog'
import { useRepository } from './repository'
import { Header } from './ui/Header'
import { Pane } from './ui/Pane'
import {
  type PendingConfirm,
  message,
  trimDirectoryPath,
  type TreeFile,
  type RepositoryViewMode,
  gitStatus,
  createRepositoryListSource,
  createTreeSource,
  FileTreeContextMenuTrigger,
  TreeSection,
} from './panes'
import {
  repositoryName,
  repositoryDropDestination,
  isHiddenRepositoryPath,
  createRepositoryTreeSource,
  filterRepositoryPaths,
  RepositoryContextMenu,
  RepositoryHeaderActions,
} from './Explorer'
import { Graph } from './Graph'
import { type ConversationsPane, Conversations } from './Conversations'

type OperationDialog = 'compare' | 'integrate' | 'stash' | 'tags' | null

type RepositoryEntryDialog =
  | { kind: 'file' | 'folder'; initialPath: string }
  | { kind: 'rename'; initialPath: string; source: string }
  | null

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

const CHANGE_TREE_VIRTUALIZATION_THRESHOLD = 8

function mutationPaths(changes: readonly TreeFile[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath == null ? [change.path] : [change.oldPath, change.path],
      ),
    ),
  ]
}

const PANE_SIZES_STORAGE_KEY = 'gitna-source-control-pane-sizes-v2'
const DEFAULT_PANE_SIZES = [46, 26, 14, 14] as const
type PaneSizes = [number, number, number, number]
type PaneResizeIndex = 0 | 1 | 2

function readPaneSizes(): PaneSizes {
  try {
    const value = JSON.parse(localStorage.getItem(PANE_SIZES_STORAGE_KEY) ?? 'null') as unknown
    if (
      Array.isArray(value) &&
      (value.length === 3 || value.length === 4) &&
      value.every((entry) => typeof entry === 'number' && entry >= 8)
    ) {
      return [value[0], value[1], value[2], value[3] ?? DEFAULT_PANE_SIZES[3]]
    }
  } catch {
    // Invalid local state falls back to the stable VS Code-style proportions.
  }
  return [...DEFAULT_PANE_SIZES]
}

function usePaneSizes() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<PaneSizes>(readPaneSizes)
  const [customized, setCustomized] = useState(() => {
    try {
      return localStorage.getItem(PANE_SIZES_STORAGE_KEY) != null
    } catch {
      return false
    }
  })
  const resizeBy = useCallback((index: PaneResizeIndex, delta: number) => {
    setCustomized(true)
    setSizes((current) => {
      const next = [...current] as PaneSizes
      const bounded = Math.max(8 - current[index], Math.min(delta, current[index + 1] - 8))
      next[index] += bounded
      next[index + 1] -= bounded
      savePreference(PANE_SIZES_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])
  const startResize = useCallback(
    (index: PaneResizeIndex, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || containerRef.current == null) return
      event.preventDefault()
      const startY = event.clientY
      const startSizes = [...sizes] as PaneSizes
      setCustomized(true)
      const height = containerRef.current.getBoundingClientRect().height
      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = ((moveEvent.clientY - startY) / Math.max(1, height)) * 100
        const bounded = Math.max(8 - startSizes[index], Math.min(delta, startSizes[index + 1] - 8))
        const next = [...startSizes] as PaneSizes
        next[index] += bounded
        next[index + 1] -= bounded
        savePreference(PANE_SIZES_STORAGE_KEY, JSON.stringify(next))
        setSizes(next)
      }
      const stop = () => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', stop)
      }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', stop, { once: true })
    },
    [sizes],
  )
  return { containerRef, customized, resizeBy, sizes, startResize }
}

function PaneResizeHandle({
  disabled,
  index,
  onResize,
  onStart,
  size,
}: {
  disabled: boolean
  index: PaneResizeIndex
  onResize: (index: PaneResizeIndex, delta: number) => void
  onStart: (index: PaneResizeIndex, event: React.PointerEvent<HTMLElement>) => void
  size: number
}) {
  return (
    <hr
      aria-disabled={disabled}
      aria-label="Resize sidebar panes"
      aria-orientation="horizontal"
      aria-valuemax={92}
      aria-valuemin={8}
      aria-valuenow={Math.round(size)}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        'relative z-20 hidden h-0 overflow-visible border-0 outline-none before:absolute before:inset-x-0 before:-top-0.5 before:h-1 before:cursor-[ns-resize] before:bg-transparent before:transition-colors before:duration-100 hover:before:bg-[var(--ring)] focus-visible:before:bg-[var(--ring)] active:before:bg-[var(--ring)] md:block',
        disabled && 'pointer-events-none',
      )}
      onPointerDown={(event) => !disabled && onStart(index, event)}
      onKeyDown={(event) => {
        if (disabled || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        onResize(index, event.key === 'ArrowUp' ? -2 : 2)
      }}
    />
  )
}

function useObservedHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element == null) return
    const update = () => setHeight(Math.ceil(element.getBoundingClientRect().height))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  })
  return height
}

function useNaturalPaneHeight(
  paneRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const pane = paneRef.current
    const content = contentRef.current
    const header = pane?.firstElementChild
    if (pane == null || content == null || !(header instanceof HTMLElement)) return
    const children = [...content.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    )
    const update = () =>
      setHeight(
        Math.ceil(
          header.getBoundingClientRect().height +
            children.reduce((total, child) => total + child.getBoundingClientRect().height, 0),
        ),
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    for (const child of children) observer.observe(child)
    return () => observer.disconnect()
  })
  return height
}

export function SourceControl({
  active = true,
  conversations,
  onFindInFiles,
  onSearchCommits,
}: {
  active?: boolean
  conversations?: ConversationsPane
  onFindInFiles?: () => void
  onSearchCommits?: () => void
}) {
  const [commitMessage, setCommitMessage] = useState('')
  const [amend, setAmend] = useState(false)
  return active ? (
    <SourceControlInner
      conversations={conversations}
      onFindInFiles={onFindInFiles}
      onSearchCommits={onSearchCommits}
      commitMessage={commitMessage}
      setCommitMessage={setCommitMessage}
      amend={amend}
      setAmend={setAmend}
    />
  ) : null
}

function SourceControlInner({
  conversations,
  onFindInFiles,
  onSearchCommits,
  commitMessage,
  setCommitMessage,
  amend,
  setAmend,
}: {
  conversations?: ConversationsPane
  onFindInFiles?: () => void
  onSearchCommits?: () => void
  commitMessage: string
  setCommitMessage: (message: string) => void
  amend: boolean
  setAmend: (amend: boolean) => void
}) {
  const repository = useRepository()
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const conversationsPaneOpen = conversations != null && conversationsOpen
  const [workflowOpen, setWorkflowOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [graphOpen, setGraphOpen] = useState(false)
  const [repositoryFilters, setRepositoryFilters] = useState<ReadonlySet<GitStatus>>(
    () => new Set(),
  )
  const [repositoryView, setRepositoryView] = useState<RepositoryViewMode>('tree')
  const [showHiddenFiles, setShowHiddenFiles] = useState(true)
  const [showIgnoredFiles, setShowIgnoredFiles] = useState(true)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [operationDialog, setOperationDialog] = useState<OperationDialog>(null)
  const [repositoryEntryDialog, setRepositoryEntryDialog] = useState<RepositoryEntryDialog>(null)
  const changesHeader = useRef<HTMLButtonElement>(null)
  const graphHeader = useRef<HTMLButtonElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const workflowPane = useRef<HTMLElement>(null)
  const workflowContent = useRef<HTMLDivElement>(null)
  const {
    containerRef,
    customized: paneSizesCustomized,
    resizeBy,
    sizes,
    startResize,
  } = usePaneSizes()
  const paneStackHeight = useObservedHeight(containerRef)
  const measuredWorkflowHeight = useNaturalPaneHeight(workflowPane, workflowContent)

  const snapshot = repository.snapshot
  const connectionHealthy = repository.connectionState === 'connected'
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const changedPathCount = new Set(
    [...staged, ...unstaged, ...(snapshot?.conflicts ?? [])].map((change) => change.path),
  ).size
  const workflowRefreshVisible = useLoadingIndicator(repository.loading)
  const repositoryRefreshing =
    repository.repositoryFilesLoading || repository.repositoryFileCountLoading
  const repositoryRefreshVisible = useLoadingIndicator(repositoryRefreshing)
  const headTitle =
    snapshot?.headBranch ??
    (snapshot?.headOid == null ? 'Detached HEAD' : `Detached at ${snapshot.headOid.slice(0, 8)}`)
  const repositoryChanges = useMemo(() => [...staged, ...unstaged], [staged, unstaged])
  const availableRepositoryStatuses = useMemo(
    () => new Set(repositoryChanges.map((change) => gitStatus(change.kind))),
    [repositoryChanges],
  )
  const activeRepositoryFilters = useMemo(
    () =>
      new Set([...repositoryFilters].filter((status) => availableRepositoryStatuses.has(status))),
    [availableRepositoryStatuses, repositoryFilters],
  )
  const visibleRepositoryPaths = useMemo(
    () =>
      repository.repositoryPaths.filter(
        (path) =>
          (showHiddenFiles || !isHiddenRepositoryPath(path)) &&
          (showIgnoredFiles || !repository.repositoryIgnoredPaths.has(path)),
      ),
    [
      repository.repositoryIgnoredPaths,
      repository.repositoryPaths,
      showHiddenFiles,
      showIgnoredFiles,
    ],
  )
  const filteredRepositoryPaths = useMemo(
    () => filterRepositoryPaths(visibleRepositoryPaths, repositoryChanges, activeRepositoryFilters),
    [visibleRepositoryPaths, repositoryChanges, activeRepositoryFilters],
  )
  const repositorySource = useMemo(
    () =>
      repositoryView === 'tree'
        ? createRepositoryTreeSource(filteredRepositoryPaths, repositoryChanges)
        : createRepositoryListSource(filteredRepositoryPaths, repositoryChanges),
    [filteredRepositoryPaths, repositoryChanges, repositoryView],
  )
  const workflowCompact = changedPathCount === 0 && repository.conflicts.length === 0
  const hasLargeOpenChangeSection =
    (stagedOpen && staged.length > CHANGE_TREE_VIRTUALIZATION_THRESHOLD) ||
    (changesOpen && unstaged.length > CHANGE_TREE_VIRTUALIZATION_THRESHOLD)
  const useNaturalWorkflowHeight =
    workflowOpen &&
    !workflowCompact &&
    (!hasLargeOpenChangeSection ||
      ((repositoryOpen || graphOpen || conversationsPaneOpen) && !paneSizesCustomized))
  const naturalWorkflowHeight = Math.min(
    measuredWorkflowHeight || 142,
    Math.max(142, (paneStackHeight * sizes[0]) / 100),
  )
  const workflowRow =
    !workflowOpen || workflowCompact
      ? 'max-content'
      : !repositoryOpen && !graphOpen && !conversationsPaneOpen
        ? 'minmax(142px, 1fr)'
        : useNaturalWorkflowHeight
          ? `${naturalWorkflowHeight}px`
          : `minmax(142px, ${sizes[0]}fr)`
  const repositoryVisibilityFiltered = !showHiddenFiles || !showIgnoredFiles
  const repositorySettledTotal = repository.repositoryFileTotal
  const repositoryExactTotal =
    repository.repositoryFileTotalGeneration === repository.generation
      ? repositorySettledTotal
      : null
  const repositoryCountOutdated = repositorySettledTotal != null && repositoryExactTotal == null
  const repositoryRowsIncomplete =
    repository.repositoryFilesLoading ||
    repository.ordinaryUnloadedDirectories.size > 0 ||
    repository.ordinaryPagedDirectories.size > 0
  const repositoryCountPending = repositorySettledTotal == null && repositoryRowsIncomplete
  let repositorySettledDisplay: string | null = null
  if (repositorySettledTotal != null) {
    repositorySettledDisplay =
      repositorySettledTotal > 999_999 ? '999999+' : `${repositorySettledTotal}`
  }
  const repositoryDenominator = repositorySettledDisplay ?? repository.repositoryPaths.length
  let repositoryCountTitle: string | undefined
  if (repositorySettledTotal != null) {
    repositoryCountTitle = `${repositorySettledTotal} files in Repository`
    if (repositoryCountOutdated) {
      repositoryCountTitle = repository.repositoryFileCountLoading
        ? `Last known: ${repositorySettledTotal} files in Repository. Refreshing exact count.`
        : `Last known: ${repositorySettledTotal} files in Repository. Exact count unavailable.`
    }
  }
  let repositoryCountText: string
  if (
    activeRepositoryFilters.size === 0 &&
    !repositoryVisibilityFiltered &&
    repositorySettledDisplay != null
  ) {
    repositoryCountText = repositorySettledDisplay
  } else if (activeRepositoryFilters.size === 0 && !repositoryVisibilityFiltered) {
    repositoryCountText = `${repository.repositoryPaths.length}${repositoryCountPending ? '+' : ''}`
  } else {
    repositoryCountText = `${filteredRepositoryPaths.length}${repositoryRowsIncomplete ? '+' : ''} / ${repositoryDenominator}${repositoryCountPending ? '+' : ''}`
  }
  let repositoryCountLabel: string | undefined
  if (repositoryCountOutdated) {
    const state = repository.repositoryFileCountLoading ? 'refreshing' : 'exact count unavailable'
    repositoryCountLabel = `${repositoryCountText}, based on the last known exact total; ${state}`
  }
  const repositoryCount = <span aria-label={repositoryCountLabel}>{repositoryCountText}</span>
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
  const pagedOrdinaryDirectory = repository.ordinaryPagedDirectories.values().next().value
  const stagedSource = useMemo(() => createTreeSource(staged), [staged])
  const unstagedSource = useMemo(() => createTreeSource(unstaged), [unstaged])
  const selectedScope = repository.selection?.scope
  const selectedChangePath = repository.selection?.change.path

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
  }, [amend, commitMessage, repository])

  const backendDisabledReason = repository.getActionDisabledReason()
  const previousMutationErrorRef = useRef(repository.mutationError)
  useEffect(() => {
    if (
      repository.mutationError != null &&
      repository.mutationError !== previousMutationErrorRef.current
    ) {
      setLocalError(null)
    }
    previousMutationErrorRef.current = repository.mutationError
  }, [repository.mutationError])

  const selectRepositoryPath = useCallback(
    (path: string) => repository.selectRepositoryFile(path),
    [repository],
  )
  const loadOrdinaryDirectory = useCallback(
    (path: string) => repository.loadOrdinaryDirectory(path),
    [repository],
  )
  const loadMoreOrdinaryDirectory = useCallback(
    (path: string) => repository.loadMoreOrdinaryDirectory(path),
    [repository],
  )
  const changeScopesForPath = useCallback(
    (path: string): readonly ChangeScope[] => {
      const scopes: ChangeScope[] = []
      if (unstaged.some((change) => change.path === path)) scopes.push('unstaged')
      if (staged.some((change) => change.path === path)) scopes.push('staged')
      return scopes
    },
    [staged, unstaged],
  )
  const canDropRepositoryPath = useCallback(
    ({ draggedPaths, target }: FileTreeDropContext) => {
      if (
        repository.busy ||
        repository.getActionDisabledReason() != null ||
        repositoryView !== 'tree' ||
        activeRepositoryFilters.size > 0 ||
        repositoryVisibilityFiltered ||
        draggedPaths.length !== 1
      ) {
        return false
      }
      const [rawSource] = draggedPaths
      const source = trimDirectoryPath(rawSource)
      const destination = repositoryDropDestination(rawSource, target.directoryPath)
      const targetDirectory =
        target.directoryPath == null ? '' : trimDirectoryPath(target.directoryPath)
      if (
        destination === source ||
        (rawSource.endsWith('/') &&
          (targetDirectory === source || targetDirectory.startsWith(`${source}/`)))
      ) {
        return false
      }
      return !repository.repositoryPaths.some(
        (path) => path === destination || path.startsWith(`${destination}/`),
      )
    },
    [
      repository.busy,
      repository.repositoryPaths,
      activeRepositoryFilters.size,
      repositoryView,
      repositoryVisibilityFiltered,
    ],
  )
  const moveRepositoryPath = useCallback(
    ({ draggedPaths, target }: FileTreeDropResult) => {
      const [rawSource] = draggedPaths
      if (rawSource == null) return
      const source = trimDirectoryPath(rawSource)
      const destination = repositoryDropDestination(rawSource, target.directoryPath)
      void run(() => repository.renameWorktreeEntry(source, destination))
    },
    [repository, run],
  )
  const repositoryDragAndDrop = useMemo<FileTreeDragAndDropConfig>(
    () => ({
      canDrag: (paths) =>
        !repository.busy &&
        repository.getActionDisabledReason() == null &&
        repositoryView === 'tree' &&
        activeRepositoryFilters.size === 0 &&
        !repositoryVisibilityFiltered &&
        paths.length === 1,
      canDrop: canDropRepositoryPath,
      onDropComplete: moveRepositoryPath,
      onDropError: (error) => setLocalError(error),
      openOnDropDelay: 600,
    }),
    [
      canDropRepositoryPath,
      moveRepositoryPath,
      repository.busy,
      activeRepositoryFilters.size,
      repositoryView,
      repositoryVisibilityFiltered,
    ],
  )
  const renderRepositoryContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext, selectedPaths: readonly string[]) => (
      <RepositoryContextMenu
        context={context}
        item={item}
        changeScopes={item.kind === 'file' ? changeScopesForPath(item.path) : []}
        compareSelected={
          selectedPaths.length === 2 &&
          selectedPaths.every(
            (path) => !path.endsWith('/') && repository.canOpenRepositoryFile(path),
          )
        }
        onCompareSelected={() => repository.openRepositoryFileComparison()}
        onCopyPath={(path) => {
          void navigator.clipboard
            .writeText(path)
            .catch((error) => setLocalError(`Could not copy path: ${message(error)}`))
        }}
        onCreate={(kind, initialPath) => setRepositoryEntryDialog({ kind, initialPath })}
        onOpen={selectRepositoryPath}
        onReveal={(path) => void run(() => repository.revealPath(path))}
        onOpenChange={(scope, path) => repository.select(scope, path)}
        onRefresh={() => void repository.refreshExplorer()}
        onRename={(source) =>
          setRepositoryEntryDialog({ kind: 'rename', source, initialPath: source })
        }
      />
    ),
    [changeScopesForPath, repository, run, selectRepositoryPath],
  )

  useEffect(() => {
    if (snapshot?.repository === false) setRepositoryOpen(true)
  }, [snapshot?.repository])

  useEffect(() => {
    if (repository.repositoryFileRevealVersion === 0) return
    setRepositoryOpen(true)
    setRepositoryFilters((current) => (current.size === 0 ? current : new Set()))
    setShowHiddenFiles(true)
    setShowIgnoredFiles(true)
  }, [repository.repositoryFileRevealVersion])

  useEffect(() => {
    if (repository.graphReveal != null) setGraphOpen(true)
  }, [repository.graphReveal])

  useEffect(() => {
    if (selectedScope == null || selectedChangePath == null) return
    setWorkflowOpen(true)
    if (selectedScope === 'staged') setStagedOpen(true)
    else setChangesOpen(true)
  }, [selectedChangePath, selectedScope])

  useEffect(() => {
    if (snapshot?.repository === false) return
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
  }, [snapshot?.repository])

  if (snapshot == null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
        {connectionHealthy &&
          (repository.error ?? <LoadingIndicator>Loading repository…</LoadingIndicator>)}
      </div>
    )
  }

  return (
    <section
      className="source-control flex h-full min-h-0 flex-col"
      aria-label={snapshot.repository ? 'Source Control workflow' : 'File Explorer'}
    >
      <div
        ref={containerRef}
        className="pane-stack grid min-h-0 flex-1 overflow-hidden overscroll-contain max-md:block max-md:overflow-y-auto"
        style={{
          gridTemplateRows: [
            ...(snapshot.repository ? [workflowRow, '0'] : []),
            repositoryOpen ? `minmax(142px, ${sizes[1]}fr)` : 'max-content',
            ...(snapshot.repository
              ? ['0', graphOpen ? `minmax(142px, ${sizes[2]}fr)` : 'max-content']
              : []),
            ...(conversations == null
              ? []
              : ['0', conversationsOpen ? `minmax(142px, ${sizes[3]}fr)` : 'max-content']),
          ].join(' '),
        }}
      >
        {snapshot.repository && (
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
        )}

        {snapshot.repository && (
          <PaneResizeHandle
            disabled={!workflowOpen || workflowCompact || !repositoryOpen}
            index={0}
            onResize={resizeBy}
            onStart={startResize}
            size={sizes[0]}
          />
        )}

        <TreeSection
          pane
          count={repositoryCount}
          countTitle={repositoryCountTitle}
          headerClassName={snapshot.repository ? undefined : 'border-t-0'}
          dragAndDrop={repositoryDragAndDrop}
          dataSection="repository"
          emptyMessage={snapshot.repository ? 'No repository files' : 'No folder files'}
          footer={
            <>
              {repository.repositoryFilesLoading && repository.repositoryPaths.length === 0 && (
                <LoadingIndicator>
                  <p className="px-8 py-2 text-xs text-muted-foreground" role="status">
                    Loading files…
                  </p>
                </LoadingIndicator>
              )}
              {connectionHealthy && repository.repositoryFilesError != null && (
                <p className="px-8 py-2 text-xs text-destructive" role="alert">
                  {repository.repositoryFilesError}
                </p>
              )}
              {!snapshot.repository && pagedOrdinaryDirectory != null && (
                <div className="px-6 py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={repository.repositoryFilesLoading}
                    onClick={() =>
                      void repository.loadMoreOrdinaryDirectory(pagedOrdinaryDirectory)
                    }
                  >
                    Load more files in{' '}
                    {pagedOrdinaryDirectory === ''
                      ? repositoryName(snapshot.root)
                      : (pagedOrdinaryDirectory.split('/').at(-1) ?? pagedOrdinaryDirectory)}
                  </Button>
                </div>
              )}
              {!snapshot.repository && repository.ordinaryWatchCoverage === 'partial' && (
                <p className="px-8 py-2 text-xs text-muted-foreground" role="status">
                  Unopened folders refresh when opened.
                </p>
              )}
            </>
          }
          renderContextMenu={renderRepositoryContextMenu}
          renderHeaderActions={(model) => (
            <RepositoryHeaderActions
              availableStatuses={availableRepositoryStatuses}
              repositoryMode={snapshot.repository}
              loading={repositoryRefreshing}
              refreshing={repositoryRefreshVisible}
              model={model}
              paths={repositoryView === 'tree' ? filteredRepositoryPaths : []}
              selectedStatuses={activeRepositoryFilters}
              showHiddenFiles={showHiddenFiles}
              showIgnoredFiles={showIgnoredFiles}
              view={repositoryView}
              onClearFilters={() => setRepositoryFilters(new Set())}
              onIsolateFilter={(status) => setRepositoryFilters(new Set([status]))}
              onCreate={(kind, initialPath) => setRepositoryEntryDialog({ kind, initialPath })}
              onFindInFiles={onFindInFiles}
              onRefresh={() => void repository.refreshExplorer()}
              onShowHiddenFilesChange={setShowHiddenFiles}
              onShowIgnoredFilesChange={setShowIgnoredFiles}
              onRename={(source) =>
                setRepositoryEntryDialog({
                  kind: 'rename',
                  source: source.replace(/\/$/, ''),
                  initialPath: source.replace(/\/$/, ''),
                })
              }
              onToggleFilter={(status) =>
                setRepositoryFilters(() => {
                  const next = new Set(activeRepositoryFilters)
                  if (next.has(status)) next.delete(status)
                  else next.add(status)
                  return next
                })
              }
              onViewChange={setRepositoryView}
            />
          )}
          icon={IconFileTree}
          lazyDirectories={
            repositoryView === 'tree' ? repository.ordinaryUnloadedDirectories : undefined
          }
          knownEmptyDirectories={
            repositoryView === 'tree' ? repository.ordinaryKnownEmptyDirectories : undefined
          }
          pagedDirectories={
            repositoryView === 'tree' ? repository.ordinaryPagedDirectories : undefined
          }
          modelId="gitna-repository-tree"
          onLoadDirectory={repositoryView === 'tree' ? loadOrdinaryDirectory : undefined}
          onLoadMoreDirectory={repositoryView === 'tree' ? loadMoreOrdinaryDirectory : undefined}
          open={repositoryOpen}
          selectedPath={repository.repositoryFilePath ?? repository.selection?.change.path}
          selectedPaths={repository.repositorySelectedPaths}
          source={repositorySource}
          title={repositoryName(snapshot.root)}
          onOpenChange={setRepositoryOpen}
          onSelectPath={selectRepositoryPath}
          onSelectPaths={(paths) => repository.setRepositorySelectedPaths(paths)}
        />

        {snapshot.repository && (
          <PaneResizeHandle
            disabled={!repositoryOpen || !graphOpen}
            index={1}
            onResize={resizeBy}
            onStart={startResize}
            size={sizes[1]}
          />
        )}

        {snapshot.repository && (
          <Graph
            onSearchCommits={onSearchCommits}
            headerRef={graphHeader}
            scrollRootRef={containerRef}
            open={graphOpen}
            onConfirm={setPendingConfirm}
            onOpenChange={setGraphOpen}
          />
        )}

        {conversations != null && snapshot.repository && (
          <PaneResizeHandle
            disabled={!graphOpen || !conversationsOpen}
            index={2}
            onResize={resizeBy}
            onStart={startResize}
            size={sizes[2]}
          />
        )}

        {conversations != null && (
          <Conversations
            conversations={conversations}
            open={conversationsOpen}
            onOpenChange={setConversationsOpen}
          />
        )}
      </div>

      {repository.uncertainMutation != null && (
        <div
          className="mx-3 mb-3 rounded-md bg-warning/15 px-2.5 py-2 text-xs text-foreground"
          role="alert"
        >
          <p>{repository.uncertainMutation}</p>
          <Button
            className="mt-2"
            size="xs"
            variant="outline"
            onClick={() => repository.acknowledgeUncertainMutation()}
          >
            Acknowledge
          </Button>
        </div>
      )}
      {connectionHealthy && (localError ?? repository.mutationError) != null && (
        <p
          className="mx-3 mb-3 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          role="alert"
        >
          {localError ?? repository.mutationError}
        </p>
      )}

      {repositoryEntryDialog != null && (
        <EntryDialog
          key={`${repositoryEntryDialog.kind}:${repositoryEntryDialog.initialPath}`}
          kind={repositoryEntryDialog.kind}
          initialPath={repositoryEntryDialog.initialPath}
          source={'source' in repositoryEntryDialog ? repositoryEntryDialog.source : undefined}
          onClose={() => setRepositoryEntryDialog(null)}
          onError={(error) => setLocalError(error || null)}
          onCreatedFolder={(path) =>
            setRepositoryEntryDialog({ kind: 'file', initialPath: `${path.replace(/\/$/, '')}/` })
          }
        />
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
          disabledReason={repository.getActionDisabledReason()}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={async () => {
            const pending = pendingConfirm
            setPendingConfirm(null)
            await run(pending.run)
          }}
        />
      )}
    </section>
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
  source: DiffsHubFileTreeSource
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
