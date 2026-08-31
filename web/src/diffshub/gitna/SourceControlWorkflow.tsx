import {
  IconBranch,
  IconChevronSm,
  IconEllipsis,
  IconFileTree,
  IconFilter,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconReply,
  IconSearch,
  IconSymbolDiffstatFill,
  IconXSquircle,
} from '@pierre/icons'
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree,
  FileTreeDirectoryHandle,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeOptions,
  GitStatus,
  GitStatusEntry,
} from '@pierre/trees'
import { useFileTreeSearch } from '@pierre/trees/react'
import { type Range, useVirtualizer } from '@tanstack/react-virtual'
import {
  type ComponentType,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { ApiError } from '../../lib/api'
import type { GraphRow } from '../../lib/graph-lanes'
import type { ChangeKind, ChangeScope, ConflictEntry } from '../../lib/types'
import { Button } from '../components/Button'
import { CHROME_ICON_BUTTON_CLASS } from '../components/chromeButtonStyles'
import { DiffsHubFileTree } from '../components/DiffsHubFileTree'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Input } from '../components/Input'
import { StatusRow } from '../components/StatusRow'
import { Switch } from '../components/Switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/Tooltip'
import { cn } from '../lib/cn'
import { CODE_VIEW_FILE_TREE_SEARCH_OPEN_HEIGHT } from '../lib/constants'
import type { DiffsHubFileTreeSource } from '../lib/types'
import {
  graphRangeExtractor,
  nextGraphFocusIndex,
  shouldLoadMoreGraph,
} from './graphVirtualization'
import { Confirm, Modal } from './Modal'
import { RepositoryEntryModal } from './RepositoryEntryModal'
import { useRepository } from './repository'

interface PendingConfirm {
  confirmLabel: string
  message: string
  run(): Promise<void>
  title: string
}

type OperationDialog = 'compare' | 'integrate' | 'stash' | 'tags' | null

type RepositoryEntryDialog =
  | { kind: 'file' | 'folder'; initialPath: string }
  | { kind: 'rename'; initialPath: string; source: string }
  | null

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function repositoryName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
}

function trimDirectoryPath(path: string): string {
  return path.replace(/\/$/, '')
}

function repositoryItemParent(item: ContextMenuItem): string {
  if (item.kind === 'directory') return `${trimDirectoryPath(item.path)}/`
  const separator = item.path.lastIndexOf('/')
  return separator < 0 ? '' : item.path.slice(0, separator + 1)
}

function repositoryDropDestination(source: string, directoryPath: string | null): string {
  const normalizedSource = trimDirectoryPath(source)
  const name = normalizedSource.slice(normalizedSource.lastIndexOf('/') + 1)
  const directory = directoryPath == null ? '' : trimDirectoryPath(directoryPath)
  return directory.length === 0 ? name : `${directory}/${name}`
}

interface TreeFile {
  kind: ChangeKind
  oldPath?: string
  path: string
}

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

type RepositoryViewMode = 'tree' | 'list'

const CHANGE_TREE_VIRTUALIZATION_THRESHOLD = 8

function isHiddenRepositoryPath(path: string): boolean {
  return path.split('/').some((segment) => segment.length > 1 && segment.startsWith('.'))
}

const REPOSITORY_FILTERS: readonly {
  color: string
  label: string
  short: string
  status: GitStatus
}[] = [
  {
    status: 'added',
    label: 'Added',
    short: 'A',
    color: 'light-dark(#16a994, #00cab1)',
  },
  {
    status: 'modified',
    label: 'Modified',
    short: 'M',
    color: 'light-dark(#1ca1c7, #08c0ef)',
  },
  {
    status: 'untracked',
    label: 'Untracked',
    short: 'U',
    color: 'light-dark(#16a994, #00cab1)',
  },
  {
    status: 'renamed',
    label: 'Renamed',
    short: 'R',
    color: 'light-dark(#d5a910, #ffd452)',
  },
  {
    status: 'deleted',
    label: 'Deleted',
    short: 'D',
    color: 'light-dark(#ff2e3f, #ff6762)',
  },
]

function mutationPaths(changes: readonly TreeFile[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath == null ? [change.path] : [change.oldPath, change.path],
      ),
    ),
  ]
}

function gitStatus(kind: ChangeKind): GitStatus {
  if (kind === 'added') return 'added'
  if (kind === 'untracked') return 'untracked'
  if (kind === 'deleted') return 'deleted'
  if (kind === 'renamed') return 'renamed'
  return 'modified'
}

function createRepositoryTreeSource(
  paths: readonly string[],
  changes: readonly TreeFile[],
): DiffsHubFileTreeSource {
  const statusesByPath = new Map(changes.map((change) => [change.path, gitStatus(change.kind)]))
  const identity = new Map(paths.filter((path) => !path.endsWith('/')).map((path) => [path, path]))
  return {
    gitStatus: paths.flatMap((path) => {
      const status = statusesByPath.get(path)
      return status == null ? [] : [{ path, status }]
    }),
    pathCount: paths.length,
    paths,
    pathToItemId: identity,
    itemIdToPath: identity,
  }
}

function createRepositoryListSource(
  paths: readonly string[],
  changes: readonly TreeFile[],
): DiffsHubFileTreeSource {
  const statusesByPath = new Map(changes.map((change) => [change.path, gitStatus(change.kind)]))
  const displayPaths: string[] = []
  const pathToItemId = new Map<string, string>()
  const itemIdToPath = new Map<string, string>()
  const used = new Set<string>()
  for (const path of paths) {
    if (path.endsWith('/')) continue
    const base = path.replaceAll('/', ' › ')
    let display = base
    while (used.has(display)) display += '\u2063'
    used.add(display)
    displayPaths.push(display)
    pathToItemId.set(display, path)
    itemIdToPath.set(path, display)
  }
  return {
    gitStatus: displayPaths.flatMap((display) => {
      const original = pathToItemId.get(display)!
      const status = statusesByPath.get(original)
      return status == null ? [] : [{ path: display, status }]
    }),
    pathCount: displayPaths.length,
    paths: displayPaths,
    pathToItemId,
    itemIdToPath,
  }
}

function filterRepositoryPaths(
  paths: readonly string[],
  changes: readonly TreeFile[],
  selectedStatuses: ReadonlySet<GitStatus>,
): string[] {
  if (selectedStatuses.size === 0) return [...paths]
  const statuses = new Map(changes.map((change) => [change.path, gitStatus(change.kind)]))
  return paths.filter((path) => {
    const status = statuses.get(path)
    return status != null && selectedStatuses.has(status)
  })
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

function treeViewportHeight(source: DiffsHubFileTreeSource): number {
  if (source.pathCount === 0) return 0
  const directories = new Set<string>()
  for (const path of source.paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  return Math.max(24, (source.pathCount + directories.size) * 24)
}

const PANE_SIZES_STORAGE_KEY = 'gitna-source-control-pane-sizes-v2'
const DEFAULT_PANE_SIZES = [52, 28, 20] as const

function readPaneSizes(): [number, number, number] {
  try {
    const value = JSON.parse(localStorage.getItem(PANE_SIZES_STORAGE_KEY) ?? 'null') as unknown
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((entry) => typeof entry === 'number' && entry >= 8)
    ) {
      return [value[0], value[1], value[2]]
    }
  } catch {
    // Invalid local state falls back to the stable VS Code-style proportions.
  }
  return [...DEFAULT_PANE_SIZES]
}

function usePaneSizes() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<[number, number, number]>(readPaneSizes)
  const [customized, setCustomized] = useState(() => {
    try {
      return localStorage.getItem(PANE_SIZES_STORAGE_KEY) != null
    } catch {
      return false
    }
  })
  const resizeBy = useCallback((index: 0 | 1, delta: number) => {
    setCustomized(true)
    setSizes((current) => {
      const next = [...current] as [number, number, number]
      const bounded = Math.max(8 - current[index], Math.min(delta, current[index + 1] - 8))
      next[index] += bounded
      next[index + 1] -= bounded
      localStorage.setItem(PANE_SIZES_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])
  const startResize = useCallback(
    (index: 0 | 1, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || containerRef.current == null) return
      event.preventDefault()
      const startY = event.clientY
      const startSizes = [...sizes] as [number, number, number]
      setCustomized(true)
      const height = containerRef.current.getBoundingClientRect().height
      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = ((moveEvent.clientY - startY) / Math.max(1, height)) * 100
        const bounded = Math.max(8 - startSizes[index], Math.min(delta, startSizes[index + 1] - 8))
        const next = [...startSizes] as [number, number, number]
        next[index] += bounded
        next[index + 1] -= bounded
        localStorage.setItem(PANE_SIZES_STORAGE_KEY, JSON.stringify(next))
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
  index: 0 | 1
  onResize(index: 0 | 1, delta: number): void
  onStart(index: 0 | 1, event: React.PointerEvent<HTMLElement>): void
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
        'relative z-20 hidden h-0 overflow-visible border-0 outline-none before:absolute before:inset-x-0 before:-top-0.5 before:h-1 before:cursor-[ns-resize] before:bg-transparent before:transition-colors before:duration-100 hover:before:bg-[var(--diffshub-primary-fg)] focus-visible:before:bg-[var(--diffshub-primary-fg)] active:before:bg-[var(--diffshub-primary-fg)] md:block',
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

function useNaturalTreeHeight(model: FileTree | null, enabled = true): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!enabled || model == null) {
      setHeight(0)
      return
    }
    const updateHeight = () => setHeight(model.getVisibleCount() * model.getItemHeight())
    updateHeight()
    return model.subscribe(updateHeight)
  }, [enabled, model])
  return height
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

export function GitnaSourceControl() {
  const repository = useRepository()
  const [repositoryOpen, setRepositoryOpen] = useState(false)
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
  const [commitMessage, setCommitMessage] = useState('')
  const [amend, setAmend] = useState(false)
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
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const changedPathCount = new Set(
    [...staged, ...unstaged, ...(snapshot?.conflicts ?? [])].map((change) => change.path),
  ).size
  const headTitle =
    snapshot?.headBranch ??
    (snapshot?.headOid == null ? 'Detached HEAD' : `Detached at ${snapshot.headOid.slice(0, 8)}`)
  const repositoryChanges = useMemo(() => [...staged, ...unstaged], [staged, unstaged])
  const availableRepositoryStatuses = useMemo(
    () => new Set(repositoryChanges.map((change) => gitStatus(change.kind))),
    [repositoryChanges],
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
    () => filterRepositoryPaths(visibleRepositoryPaths, repositoryChanges, repositoryFilters),
    [visibleRepositoryPaths, repositoryChanges, repositoryFilters],
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
    (!hasLargeOpenChangeSection || ((repositoryOpen || graphOpen) && !paneSizesCustomized))
  const naturalWorkflowHeight = Math.min(
    measuredWorkflowHeight || 142,
    Math.max(142, (paneStackHeight * sizes[0]) / 100),
  )
  const workflowRow =
    !workflowOpen || workflowCompact
      ? 'max-content'
      : !repositoryOpen && !graphOpen
        ? 'minmax(142px, 1fr)'
        : useNaturalWorkflowHeight
          ? `${naturalWorkflowHeight}px`
          : `minmax(142px, ${sizes[0]}fr)`
  const repositoryVisibilityFiltered = !showHiddenFiles || !showIgnoredFiles
  const repositoryExactTotal =
    repository.repositoryFileTotalGeneration === repository.generation
      ? repository.repositoryFileTotal
      : null
  const repositoryRowsIncomplete =
    repository.repositoryFilesLoading ||
    repository.ordinaryUnloadedDirectories.size > 0 ||
    repository.ordinaryPagedDirectories.size > 0
  const repositoryCountPending = repositoryExactTotal == null && repositoryRowsIncomplete
  const repositoryExactDisplay =
    repositoryExactTotal == null
      ? null
      : repositoryExactTotal > 999_999
        ? '999999+'
        : `${repositoryExactTotal}`
  const repositoryDenominator = repositoryExactDisplay ?? repository.repositoryPaths.length
  const repositoryCountTitle =
    repositoryExactTotal == null ? undefined : `${repositoryExactTotal} files in Repository`
  const repositoryCount =
    repositoryFilters.size === 0 && !repositoryVisibilityFiltered && repositoryExactDisplay != null
      ? repositoryExactDisplay
      : repositoryFilters.size === 0 && !repositoryVisibilityFiltered
        ? `${repository.repositoryPaths.length}${repositoryCountPending ? '+' : ''}`
        : `${filteredRepositoryPaths.length}${repositoryRowsIncomplete ? '+' : ''} / ${repositoryDenominator}${repositoryCountPending ? '+' : ''}`
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
    setLocalError(null)
    try {
      await repository.commit(nextMessage, amend)
      setCommitMessage('')
    } catch (error) {
      setLocalError(message(error))
    }
  }, [amend, commitMessage, repository])

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
        repositoryView !== 'tree' ||
        repositoryFilters.size > 0 ||
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
      repositoryFilters.size,
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
        repositoryView === 'tree' &&
        repositoryFilters.size === 0 &&
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
      repositoryFilters.size,
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
        onOpenChange={(scope, path) => repository.select(scope, path)}
        onRefresh={() => void repository.refreshExplorer()}
        onRename={(source) =>
          setRepositoryEntryDialog({ kind: 'rename', source, initialPath: source })
        }
      />
    ),
    [changeScopesForPath, repository, selectRepositoryPath],
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
        {repository.error ?? 'Loading repository…'}
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
        className="pane-stack gitna-scrollbar grid min-h-0 flex-1 overflow-hidden max-md:block max-md:overflow-y-auto"
        style={{
          gridTemplateRows: snapshot.repository
            ? `${workflowRow} 0 ${repositoryOpen ? `minmax(142px, ${sizes[1]}fr)` : 'max-content'} 0 ${graphOpen ? `minmax(142px, ${sizes[2]}fr)` : 'max-content'}`
            : repositoryOpen
              ? 'minmax(142px, 1fr)'
              : 'max-content',
        }}
      >
        {snapshot.repository && (
          <section
            ref={workflowPane}
            data-pane="source-control"
            className="section min-h-0 overflow-hidden md:flex md:flex-col"
          >
            <PaneSectionHeader
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
              count={changedPathCount > 0 ? changedPathCount : null}
              countTitle={
                changedPathCount > 0
                  ? `${changedPathCount} changed ${changedPathCount === 1 ? 'file' : 'files'}`
                  : undefined
              }
              open={workflowOpen}
              title={headTitle}
              onOpenChange={setWorkflowOpen}
            />
            {workflowOpen && (
              <div
                ref={workflowContent}
                data-pane-body="source-control"
                className="gitna-scrollbar min-h-0 overscroll-contain md:flex md:flex-1 md:flex-col md:overflow-x-hidden md:overflow-y-auto max-md:overflow-visible"
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
                    <label
                      htmlFor="gitna-amend"
                      className="mr-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <Switch
                        id="gitna-amend"
                        aria-label="Amend"
                        checked={amend}
                        disabled={repository.busy || staged.length === 0}
                        onCheckedChange={setAmend}
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
              </div>
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
              {repository.repositoryFilesLoading && (
                <p className="px-8 py-2 text-xs text-muted-foreground">
                  {repository.repositoryPaths.length === 0 ? 'Loading files…' : 'Refreshing files…'}
                </p>
              )}
              {repository.repositoryFilesError != null && (
                <p className="px-8 py-2 text-xs text-red-500" role="alert">
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
              loading={repository.repositoryFilesLoading}
              model={model}
              paths={repositoryView === 'tree' ? filteredRepositoryPaths : []}
              selectedStatuses={repositoryFilters}
              showHiddenFiles={showHiddenFiles}
              showIgnoredFiles={showIgnoredFiles}
              view={repositoryView}
              onClearFilters={() => setRepositoryFilters(new Set())}
              onIsolateFilter={(status) => setRepositoryFilters(new Set([status]))}
              onCreate={(kind, initialPath) => setRepositoryEntryDialog({ kind, initialPath })}
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
                setRepositoryFilters((current) => {
                  const next = new Set(current)
                  if (next.has(status)) next.delete(status)
                  else next.add(status)
                  return next
                })
              }
              onViewChange={setRepositoryView}
            />
          )}
          icon={<IconFileTree className="size-3" />}
          paneIcon={IconFileTree}
          lazyDirectories={
            repositoryView === 'tree' ? repository.ordinaryUnloadedDirectories : undefined
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
          <GraphSection
            headerRef={graphHeader}
            scrollRootRef={containerRef}
            open={graphOpen}
            onConfirm={setPendingConfirm}
            onOpenChange={setGraphOpen}
          />
        )}
      </div>

      {(localError ?? repository.mutationError) != null && (
        <p
          className="mx-3 mb-3 rounded-md bg-red-500/10 px-2.5 py-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
        >
          {localError ?? repository.mutationError}
        </p>
      )}

      {repositoryEntryDialog != null && (
        <RepositoryEntryModal
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

interface SourceControlHeaderActionsProps {
  moreTrigger: React.RefObject<HTMLButtonElement | null>
  onConfirm(confirm: PendingConfirm): void
  onError(error: string | null): void
  onOpenDialog(dialog: Exclude<OperationDialog, null>): void
}

function SourceControlHeaderActions({
  moreTrigger,
  onConfirm,
  onError,
  onOpenDialog,
}: SourceControlHeaderActionsProps) {
  const repository = useRepository()
  const [branchQuery, setBranchQuery] = useState('')
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [publishBranch, setPublishBranch] = useState<string | null>(null)
  const [publishRemote, setPublishRemote] = useState('origin')
  const normalizedBranchQuery = branchQuery.trim().toLocaleLowerCase()
  const localBranches = repository.branches.filter(
    (branch) => !branch.remote && branch.name.toLocaleLowerCase().includes(normalizedBranchQuery),
  )
  const remoteBranches = repository.branches.filter(
    (branch) => branch.remote && branch.name.toLocaleLowerCase().includes(normalizedBranchQuery),
  )
  const remotes = useMemo(() => {
    const values = new Set<string>()
    for (const branch of repository.branches) {
      if (!branch.remote) continue
      const slash = branch.name.indexOf('/')
      if (slash > 0) values.add(branch.name.slice(0, slash))
    }
    return [...values].sort((left, right) => left.localeCompare(right))
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

  const snapshot = repository.snapshot
  const upstream = snapshot?.upstream
  const unpublished = snapshot?.headBranch != null && upstream == null
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
        <DropdownMenuContent align="start" className="w-72 p-2">
          <form
            className="mb-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const name = branchQuery.trim()
              if (name.length === 0) return
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
            <Button variant="outline" size="sm" type="submit" disabled={branchQuery.trim() === ''}>
              New
            </Button>
          </form>
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Local branches
          </p>
          {localBranches.map((branch) =>
            branch.current ? (
              <DropdownMenuItem key={branch.name} disabled>
                <span className="w-4" />
                <span className="min-w-0 flex-1 truncate font-medium">{branch.name}</span>
                <span className="text-[10px] text-muted-foreground">
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
              <DropdownMenuSub key={branch.name}>
                <DropdownMenuSubTrigger disabled={repository.busy}>
                  <span className="w-4" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.upstream != null && (
                    <span className="text-[10px] text-muted-foreground">
                      {branch.ahead > 0 ? `↑${branch.ahead}` : ''}
                      {branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                    </span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onSelect={() => void run(() => repository.switchBranch(branch.name))}
                  >
                    Switch to branch
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-red-600 dark:text-red-400"
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
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Remote branches
              </p>
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                Select a remote branch to check it out locally.
              </p>
              {remoteBranches.map((branch) => {
                const localName = branch.name.slice(branch.name.indexOf('/') + 1)
                return (
                  <DropdownMenuItem
                    key={branch.name}
                    aria-label={`Checkout ${branch.name} as ${localName}`}
                    disabled={repository.busy}
                    onSelect={() => void run(() => repository.createBranch(localName, branch.name))}
                  >
                    <span className="w-4" />
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      Checkout as {localName}
                    </span>
                  </DropdownMenuItem>
                )
              })}
            </>
          )}
          {localBranches.length === 0 && remoteBranches.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No matching branches</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-only"
        disabled={repository.busy}
        aria-label="Fetch"
        title="Fetch"
        className={CHROME_ICON_BUTTON_CLASS}
        onClick={() => void run(() => repository.operation({ op: 'fetch' }))}
      >
        <IconRefresh className="size-4 md:size-3" />
      </Button>
      {unpublished && (
        <Button
          variant="ghost"
          size="xs"
          disabled={repository.busy}
          aria-label="Publish branch"
          title="Publish branch"
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
            title="More actions"
            className={CHROME_ICON_BUTTON_CLASS}
          >
            <IconEllipsis className="size-4 md:size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void run(() => repository.operation({ op: 'pull' }))}>
            Pull
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void push()}>Push</DropdownMenuItem>
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
        <Modal title={`Publish ${publishBranch}`} onClose={() => setPublishBranch(null)}>
          <div className="flex items-center gap-2 text-xs" role="status">
            <span className="min-w-0 flex-1 truncate">
              <b>{publishBranch}</b> has no upstream
            </span>
            <select
              aria-label="Publish remote"
              className="cursor-pointer rounded border border-border bg-background px-1 py-1 outline-none focus:border-[var(--diffshub-primary-fg)]"
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
        </Modal>
      )}
    </>
  )
}

interface WorkflowSectionHeaderProps {
  className?: string
  dataSection: string
  headerRef?: React.Ref<HTMLButtonElement>
  icon: ReactNode
  onOpenChange(open: boolean): void
  open: boolean
  title: string
}

function WorkflowSectionHeader({
  className,
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
        'section-header flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--diffshub-primary-fg)]',
        className,
      )}
      data-section={dataSection}
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
    >
      <IconChevronSm className={cn('size-3 transition-transform', !open && '-rotate-90')} />
      {icon}
      <span className="section-title min-w-0 flex-1 truncate font-medium">{title}</span>
    </button>
  )
}

interface PaneSectionHeaderProps {
  actions?: ReactNode
  className?: string
  count?: ReactNode
  countTitle?: string
  dataSection: string
  headerRef?: React.Ref<HTMLButtonElement>
  icon: ComponentType<{ className?: string }>
  onOpenChange(open: boolean): void
  open: boolean
  title: string
}

function PaneSectionHeader({
  actions,
  className,
  count,
  countTitle,
  dataSection,
  headerRef,
  icon,
  onOpenChange,
  open,
  title,
}: PaneSectionHeaderProps) {
  return (
    <StatusRow icon={icon} className={cn('group/pane-header shrink-0 text-sm', className)}>
      <button
        ref={headerRef}
        type="button"
        className="section-header text-muted-foreground hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm focus:outline-none"
        data-section={dataSection}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="section-title min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        {count != null && (
          <span
            className="section-count tabular-nums text-muted-foreground/75 text-xs"
            title={countTitle}
          >
            {count}
          </span>
        )}
      </button>
      {actions != null && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
    </StatusRow>
  )
}

function setRepositoryFoldersExpanded(
  model: FileTree | null,
  paths: readonly string[],
  expanded: boolean,
): void {
  if (model == null) return
  const directories = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  const ordered = [...directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length
    return expanded ? depth : -depth
  })
  for (const path of ordered) {
    const item = model.getItem(path)
    if (item?.isDirectory()) {
      const directory = item as FileTreeDirectoryHandle
      if (expanded) directory.expand()
      else directory.collapse()
    }
  }
}

function repositoryCreationParent(model: FileTree | null): string {
  const selected = model?.getSelectedPaths()[0]
  if (selected == null) return ''
  if (selected.endsWith('/')) return selected
  const separator = selected.lastIndexOf('/')
  return separator < 0 ? '' : selected.slice(0, separator + 1)
}

function contextMenuTriggerStyle(anchorRect: ContextMenuOpenContext['anchorRect']): CSSProperties {
  return {
    border: 0,
    height: 1,
    left: anchorRect.left,
    opacity: 0,
    padding: 0,
    pointerEvents: 'none',
    position: 'fixed',
    top: anchorRect.bottom - 1,
    width: 1,
  }
}

function FileTreeContextMenuTrigger({ context }: { context: ContextMenuOpenContext }) {
  return createPortal(
    <DropdownMenuTrigger asChild>
      <button
        aria-hidden="true"
        tabIndex={-1}
        type="button"
        style={contextMenuTriggerStyle(context.anchorRect)}
      />
    </DropdownMenuTrigger>,
    context.anchorElement.ownerDocument.body,
  )
}

function RepositoryContextMenu({
  changeScopes,
  compareSelected,
  context,
  item,
  onCompareSelected,
  onCopyPath,
  onCreate,
  onOpen,
  onOpenChange,
  onRefresh,
  onRename,
}: {
  changeScopes: readonly ChangeScope[]
  compareSelected: boolean
  context: ContextMenuOpenContext
  item: ContextMenuItem
  onCompareSelected(): void
  onCopyPath(path: string): void
  onCreate(kind: 'file' | 'folder', initialPath: string): void
  onOpen(path: string): void
  onOpenChange(scope: ChangeScope, path: string): void
  onRefresh(): void
  onRename(source: string): void
}) {
  const closeForDialog = () => context.close({ restoreFocus: false })
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
        {item.kind === 'file' && (
          <>
            <DropdownMenuItem
              onSelect={() => {
                context.close()
                onOpen(item.path)
              }}
            >
              Open
            </DropdownMenuItem>
            {compareSelected && (
              <DropdownMenuItem
                onSelect={() => {
                  context.close({ restoreFocus: false })
                  onCompareSelected()
                }}
              >
                Compare Selected
              </DropdownMenuItem>
            )}
            {changeScopes.map((scope) => (
              <DropdownMenuItem
                key={scope}
                onSelect={() => {
                  onOpenChange(scope, item.path)
                  context.close({ restoreFocus: false })
                }}
              >
                {scope === 'staged' ? 'View Staged Changes' : 'View Unstaged Changes'}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onSelect={() => {
            closeForDialog()
            onCreate('file', repositoryItemParent(item))
          }}
        >
          New File
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            closeForDialog()
            onCreate('folder', repositoryItemParent(item))
          }}
        >
          New Folder
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            closeForDialog()
            onRename(trimDirectoryPath(item.path))
          }}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            context.close()
            onCopyPath(trimDirectoryPath(item.path))
          }}
        >
          Copy Relative Path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            context.close()
            onRefresh()
          }}
        >
          Refresh Explorer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChangeContextMenu({
  canOpen,
  context,
  path,
  onOpen,
}: {
  canOpen: boolean
  context: ContextMenuOpenContext
  path: string
  onOpen(path: string): void
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
        <DropdownMenuItem
          disabled={!canOpen}
          onSelect={() => {
            context.close()
            onOpen(path)
          }}
        >
          Open in Explorer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RepositoryHeaderActions({
  availableStatuses,
  repositoryMode,
  loading,
  model,
  onClearFilters,
  onCreate,
  onIsolateFilter,
  onRefresh,
  onRename,
  onShowHiddenFilesChange,
  onShowIgnoredFilesChange,
  onToggleFilter,
  onViewChange,
  paths,
  selectedStatuses,
  showHiddenFiles,
  showIgnoredFiles,
  view,
}: {
  availableStatuses: ReadonlySet<GitStatus>
  repositoryMode: boolean
  loading: boolean
  model: FileTree | null
  onClearFilters(): void
  onCreate(kind: 'file' | 'folder', initialPath: string): void
  onIsolateFilter(status: GitStatus): void
  onRefresh(): void
  onRename(source: string): void
  onShowHiddenFilesChange(show: boolean): void
  onShowIgnoredFilesChange(show: boolean): void
  onToggleFilter(status: GitStatus): void
  onViewChange(view: RepositoryViewMode): void
  paths: readonly string[]
  selectedStatuses: ReadonlySet<GitStatus>
  showHiddenFiles: boolean
  showIgnoredFiles: boolean
  view: RepositoryViewMode
}) {
  const filtered = selectedStatuses.size > 0
  const visibleFilters = REPOSITORY_FILTERS.filter(({ status }) => availableStatuses.has(status))
  const [isMac] = useState(
    () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform),
  )
  const altKeyRef = useRef(false)
  return (
    <>
      {repositoryMode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-only"
              aria-label="Filter by Git status"
              aria-pressed={filtered}
              className={cn(CHROME_ICON_BUTTON_CLASS, 'relative')}
              title="Filter by Git status"
            >
              <IconFilter className="size-4 md:size-3" />
              {filtered && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-[1px] border-[var(--diffshub-sidebar-bg)] bg-blue-500 dark:bg-blue-400"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-2">
            <DropdownMenuLabel className="flex flex-col px-2 font-normal">
              Filter by Git status
              <small className="text-xs text-muted-foreground">
                {isMac ? 'Option' : 'Alt'}-click to show only one status
              </small>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="mx-2" />
            {visibleFilters.map(({ status, label, short, color }) => (
              <DropdownMenuCheckboxItem
                key={status}
                checked={selectedStatuses.has(status)}
                indicatorSide="right"
                className={filtered && !selectedStatuses.has(status) ? 'text-muted-foreground' : ''}
                onPointerDown={(event) => {
                  altKeyRef.current = event.altKey
                }}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => {
                  if (altKeyRef.current) onIsolateFilter(status)
                  else onToggleFilter(status)
                }}
              >
                <span
                  className="mr-2 w-4 shrink-0 rounded-sm text-center font-mono text-xs font-semibold"
                  style={{
                    color,
                    backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
                  }}
                >
                  {short}
                </span>
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator className="mx-2" />
            <DropdownMenuItem className="px-2" disabled={!filtered} onSelect={onClearFilters}>
              <IconXSquircle className="mr-2 opacity-50" />
              Clear filter
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="ghost"
        size="icon-only"
        className={CHROME_ICON_BUTTON_CLASS}
        aria-label="Refresh Explorer"
        title="Refresh Explorer"
        disabled={loading}
        onClick={onRefresh}
      >
        <IconRefresh className="size-4 md:size-3" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-only"
            className={CHROME_ICON_BUTTON_CLASS}
            aria-label="Explorer actions"
            title="Explorer actions"
          >
            <IconEllipsis className="size-4 md:size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onCreate('file', repositoryCreationParent(model))}>
            New File
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCreate('folder', repositoryCreationParent(model))}>
            New Folder
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={model == null}
            onSelect={() => {
              const source = model?.getSelectedPaths()[0]
              if (source != null) onRename(source)
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={showHiddenFiles}
            indicatorSide="right"
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onShowHiddenFilesChange(!showHiddenFiles)}
          >
            Show hidden files
          </DropdownMenuCheckboxItem>
          {repositoryMode && (
            <DropdownMenuCheckboxItem
              checked={showIgnoredFiles}
              indicatorSide="right"
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => onShowIgnoredFilesChange(!showIgnoredFiles)}
            >
              Show ignored files
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem selected={view === 'tree'} onSelect={() => onViewChange('tree')}>
            Show as Tree
          </DropdownMenuItem>
          <DropdownMenuItem selected={view === 'list'} onSelect={() => onViewChange('list')}>
            Show as List
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={view !== 'tree' || model == null}
            onSelect={() => setRepositoryFoldersExpanded(model, paths, true)}
          >
            Expand all folders
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={view !== 'tree' || model == null}
            onSelect={() => setRepositoryFoldersExpanded(model, paths, false)}
          >
            Collapse all folders
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

interface TreeSectionProps {
  count?: ReactNode
  countTitle?: string
  dataSection: string
  dragAndDrop?: FileTreeDragAndDropConfig
  emptyMessage: string
  fill?: boolean
  footer?: ReactNode
  headerActions?: ReactNode
  headerClassName?: string
  headerRef?: React.Ref<HTMLButtonElement>
  icon: ReactNode
  modelId: string
  lazyDirectories?: ReadonlySet<string>
  pagedDirectories?: ReadonlySet<string>
  onLoadDirectory?(path: string): Promise<readonly string[] | null>
  onLoadMoreDirectory?(path: string): Promise<readonly string[] | null>
  onOpenChange(open: boolean): void
  onSelectPath(path: string): void
  onSelectPaths?(paths: readonly string[]): void
  open: boolean
  pane?: boolean
  paneIcon?: ComponentType<{ className?: string }>
  renderContextMenu?: (
    item: ContextMenuItem,
    context: ContextMenuOpenContext,
    selectedPaths: readonly string[],
  ) => ReactNode
  renderHeaderActions?: (model: FileTree | null) => ReactNode
  renderRowActions?: FileTreeOptions['renderRowActions']
  selectedPath?: string | null
  selectedPaths?: readonly string[]
  source: DiffsHubFileTreeSource
  title: string
}

function TreeSection({
  count,
  countTitle,
  dataSection,
  dragAndDrop,
  emptyMessage,
  fill = false,
  footer,
  headerActions,
  headerClassName,
  headerRef,
  icon,
  lazyDirectories,
  pagedDirectories,
  modelId,
  onLoadDirectory,
  onLoadMoreDirectory,
  onOpenChange,
  onSelectPath,
  onSelectPaths,
  open,
  pane = false,
  paneIcon,
  renderContextMenu,
  renderHeaderActions,
  renderRowActions,
  selectedPath,
  selectedPaths,
  source,
  title,
}: TreeSectionProps) {
  const [model, setModel] = useState<FileTree | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const naturalHeight = useNaturalTreeHeight(model, !pane)
  const searchHeight = searchOpen ? CODE_VIEW_FILE_TREE_SEARCH_OPEN_HEIGHT : 0
  const height = (naturalHeight > 0 ? naturalHeight : treeViewportHeight(source)) + searchHeight
  return (
    <section
      data-pane={pane ? 'repository' : undefined}
      className={cn(
        'section',
        !pane && 'border-t border-border/70 first:border-t-0',
        !pane && !fill && 'shrink-0',
        fill && open && 'md:flex md:min-h-0 md:flex-1 md:flex-col md:overflow-hidden',
        pane && 'flex h-full min-h-0 flex-col overflow-hidden',
        pane && open && 'max-md:h-[50vh]',
        pane && !open && 'max-md:h-auto',
      )}
    >
      {pane ? (
        <PaneSectionHeader
          className={headerClassName}
          actions={
            <>
              {open && model != null && source.pathCount > 0 && lazyDirectories == null && (
                <TreeSearchToggle
                  model={model}
                  title={dataSection === 'repository' ? 'Repository' : title}
                  onOpenChange={setSearchOpen}
                />
              )}
              {renderHeaderActions?.(model)}
              {headerActions}
            </>
          }
          count={count ?? source.pathCount}
          countTitle={
            countTitle ??
            `${count ?? source.pathCount} files in ${dataSection === 'repository' ? 'Repository' : title}`
          }
          dataSection={dataSection}
          headerRef={headerRef}
          icon={paneIcon ?? IconFileTree}
          open={open}
          title={title}
          onOpenChange={onOpenChange}
        />
      ) : (
        <div className="group/tree-header flex h-8 shrink-0 items-center hover:bg-muted focus-within:bg-muted">
          <WorkflowSectionHeader
            className="min-w-0 flex-1"
            dataSection={dataSection}
            headerRef={headerRef}
            icon={icon}
            open={open}
            title={title}
            onOpenChange={onOpenChange}
          />
          {headerActions != null && (
            <div className="flex shrink-0 items-center opacity-0 group-focus-within/tree-header:opacity-100 group-hover/tree-header:opacity-100 max-md:opacity-100">
              {headerActions}
            </div>
          )}
          <span className="section-count min-w-7 shrink-0 pr-3 text-right text-xs tabular-nums text-muted-foreground">
            {source.pathCount}
          </span>
        </div>
      )}
      {open && (
        <>
          <div
            data-pane-body={pane ? 'repository' : undefined}
            className={cn(
              pane && 'min-h-0 flex-1 overflow-hidden',
              fill && 'md:min-h-0 md:flex-1 md:overflow-hidden',
            )}
          >
            {source.pathCount > 0 && (
              <div
                className={cn(
                  'min-h-0',
                  pane && 'h-full',
                  fill && 'h-[var(--gitna-tree-natural-height)] md:h-full',
                )}
                style={
                  pane
                    ? undefined
                    : fill
                      ? ({ '--gitna-tree-natural-height': `${height}px` } as CSSProperties)
                      : { height }
                }
              >
                <DiffsHubFileTree
                  className={cn(
                    pane ? 'h-full overflow-hidden' : fill ? 'md:h-full' : 'overflow-visible',
                    'md:ml-2',
                  )}
                  dragAndDrop={dragAndDrop}
                  lazyDirectories={lazyDirectories}
                  pagedDirectories={pagedDirectories}
                  modelId={modelId}
                  onLoadDirectory={onLoadDirectory}
                  onLoadMoreDirectory={onLoadMoreDirectory}
                  onModelReady={setModel}
                  onSelectItem={onSelectPath}
                  onSelectPaths={onSelectPaths}
                  renderContextMenu={renderContextMenu}
                  renderRowActions={renderRowActions}
                  selectedPath={selectedPath}
                  selectedPaths={selectedPaths}
                  showFolderGitStatus={pane}
                  source={source}
                />
              </div>
            )}
            {source.pathCount === 0 && (
              <p className="px-8 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
            )}
          </div>
          {footer != null && <div className="shrink-0">{footer}</div>}
        </>
      )}
    </section>
  )
}

function TreeSearchToggle({
  model,
  onOpenChange,
  title,
}: {
  model: FileTree
  onOpenChange(open: boolean): void
  title: string
}) {
  const search = useFileTreeSearch(model)
  useEffect(() => onOpenChange(search.isOpen), [onOpenChange, search.isOpen])
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-only"
      aria-label={search.isOpen ? `Hide ${title} search` : `Search ${title}`}
      aria-pressed={search.isOpen}
      className={CHROME_ICON_BUTTON_CLASS}
      title={search.isOpen ? `Hide ${title} search` : `Search ${title}`}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => (search.isOpen ? search.close() : search.open())}
    >
      <IconSearch className="size-4 md:size-3" />
    </Button>
  )
}

interface ChangeSectionProps {
  changes: readonly TreeFile[]
  headerRef?: React.Ref<HTMLButtonElement>
  modelId: string
  onConfirm(confirm: PendingConfirm): void
  onOpenChange(open: boolean): void
  onRun(action: () => Promise<void>): Promise<void>
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
      if (item.kind !== 'file') return null
      const path = trimDirectoryPath(item.path)
      return (
        <ChangeContextMenu
          canOpen={repository.canOpenRepositoryFile(path)}
          context={context}
          path={path}
          onOpen={(nextPath) => void onRun(() => repository.openRepositoryFile(nextPath, true))}
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
      if (scope === 'staged') {
        return [
          {
            id: 'unstage',
            label: `Unstage ${item.name}`,
            icon: { name: 'gitna-action-unstage' },
            disabled: repository.busy,
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
          label: `Discard changes in ${item.name}`,
          icon: { name: 'gitna-action-discard' },
          disabled: repository.busy,
          onAction: () =>
            onConfirm({
              ...discardConfirmationCopy(item.name, itemChanges, row.kind === 'directory'),
              run: () => discardChanges(itemChanges),
            }),
        },
        {
          id: 'stage',
          label: `Stage ${item.name}`,
          icon: { name: 'gitna-action-stage' },
          disabled: repository.busy,
          onAction: () =>
            void onRun(() => repository.mutate({ op: 'stage', paths: mutationPaths(itemChanges) })),
        },
      ]
    },
    [changes, changesByPath, discardChanges, onConfirm, onRun, repository, scope],
  )

  const headerActions =
    scope === 'staged' ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-only"
        aria-label="Unstage all changes"
        title="Unstage All Changes"
        disabled={repository.busy}
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
          title="Discard All Changes"
          disabled={repository.busy}
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
          title="Stage All Changes"
          disabled={repository.busy}
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
      icon={<IconSymbolDiffstatFill className="size-3" />}
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

interface GraphSectionProps {
  headerRef: React.RefObject<HTMLButtonElement | null>
  scrollRootRef: React.RefObject<HTMLDivElement | null>
  onConfirm(confirm: PendingConfirm): void
  onOpenChange(open: boolean): void
  open: boolean
}

const GRAPH_LANE_SPACING = 12
const GRAPH_LANE_INSET = 8
const GRAPH_ROW_HEIGHT = 28
const GRAPH_LANE_COLORS = [
  'var(--diffshub-primary-fg, #3b82f6)',
  '#f59e0b',
  '#a855f7',
  '#10b981',
  '#f43f5e',
]

function graphColumnX(column: number): number {
  return GRAPH_LANE_INSET + column * GRAPH_LANE_SPACING
}

function graphLaneColor(column: number): string {
  return GRAPH_LANE_COLORS[column % GRAPH_LANE_COLORS.length]!
}

function relativeCommitTime(value: string): string {
  const elapsedSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, seconds] of units) {
    if (Math.abs(elapsedSeconds) >= seconds) {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit)
    }
  }
  return formatter.format(elapsedSeconds, 'second')
}

type GraphPinReason = 'menu' | 'tooltip'

interface GraphScrollAnchor {
  index: number
  offset: number
  oid: string
}

function GraphSection({
  headerRef,
  scrollRootRef,
  onConfirm,
  onOpenChange,
  open,
}: GraphSectionProps) {
  const repository = useRepository()
  const [view, setView] = useState<RepositoryViewMode>('tree')
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pins, setPins] = useState<ReadonlySet<string>>(() => new Set())
  const graphBodyRef = useRef<HTMLDivElement>(null)
  const continuationArmedRef = useRef(false)
  const anchorRef = useRef<GraphScrollAnchor | null>(null)
  const previousRowsRef = useRef<readonly string[]>([])
  const laneCount = Math.max(1, ...repository.graphRows.map((row) => row.totalColumns))
  const pinnedIndices = useMemo(() => {
    const indices = new Set<number>()
    if (repository.graphRows[activeIndex] != null) indices.add(activeIndex)
    for (const pin of pins) {
      const oid = pin.slice(pin.indexOf(':') + 1)
      const index = repository.graphRows.findIndex((row) => row.commit.oid === oid)
      if (index >= 0) indices.add(index)
    }
    return [...indices]
  }, [activeIndex, pins, repository.graphRows])
  const rangeExtractor = useCallback(
    (range: Range) => graphRangeExtractor(range, pinnedIndices),
    [pinnedIndices],
  )
  const virtualizer = useVirtualizer({
    count: repository.graphRows.length,
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
    enabled: open,
    estimateSize: () => GRAPH_ROW_HEIGHT + 8,
    getItemKey: (index) => repository.graphRows[index]?.commit.oid ?? index,
    getScrollElement: () => (mobile ? scrollRootRef.current : graphBodyRef.current),
    onChange(instance) {
      const scrollOffset = instance.scrollOffset ?? 0
      const item = instance.getVirtualItems().find((candidate) => candidate.end > scrollOffset)
      const oid =
        item == null
          ? undefined
          : (previousRowsRef.current[item.index] ?? repository.graphRows[item.index]?.commit.oid)
      if (item != null && oid != null) {
        anchorRef.current = {
          index: item.index,
          offset: scrollOffset - item.start,
          oid,
        }
      }
    },
    overscan: 2,
    rangeExtractor,
    scrollMargin,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const graphCount = repository.graphTotal == null ? null : `${repository.graphTotal}`
  const graphSetSize =
    repository.graphTotal ?? (repository.graphHasMore ? -1 : repository.graphRows.length)
  const armContinuation = useCallback(() => {
    continuationArmedRef.current = true
  }, [])

  useEffect(() => {
    if (
      !open ||
      !continuationArmedRef.current ||
      repository.graphLoading ||
      repository.graphError != null ||
      !repository.graphHasMore
    ) {
      return
    }
    const lastVisible = virtualizer.range?.endIndex ?? -1
    if (!shouldLoadMoreGraph(lastVisible, repository.graphRows.length)) return
    continuationArmedRef.current = false
    void repository.loadMoreGraph()
  }, [
    open,
    repository,
    repository.graphError,
    repository.graphHasMore,
    repository.graphLoading,
    repository.graphRows.length,
    virtualItems,
  ])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (!open || !mobile) {
      setScrollMargin(0)
      return
    }
    const body = graphBodyRef.current
    const root = scrollRootRef.current
    if (body == null || root == null) return
    const update = () => {
      const bodyBox = body.getBoundingClientRect()
      const rootBox = root.getBoundingClientRect()
      setScrollMargin(Math.round(bodyBox.top - rootBox.top + root.scrollTop))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(body)
    observer.observe(root)
    for (const pane of root.querySelectorAll<HTMLElement>('[data-pane]')) observer.observe(pane)
    return () => observer.disconnect()
  }, [mobile, open, scrollRootRef])

  useLayoutEffect(() => {
    const rows = repository.graphRows.map((row) => row.commit.oid)
    const previousRows = previousRowsRef.current
    const anchor = anchorRef.current
    if (anchor != null && previousRows.length > 0) {
      const previousIndex = previousRows.indexOf(anchor.oid)
      const nextIndex = rows.indexOf(anchor.oid)
      if (previousIndex >= 0 && nextIndex >= 0) {
        virtualizer.scrollToIndex(nextIndex, { align: 'start' })
        requestAnimationFrame(() => {
          const item = virtualizer
            .getVirtualItems()
            .find((candidate) => candidate.index === nextIndex)
          if (item != null) virtualizer.scrollToOffset(item.start + anchor.offset)
        })
      }
    }
    const activeOid = previousRows[activeIndex]
    if (activeOid != null) {
      const nextActiveIndex = rows.indexOf(activeOid)
      setActiveIndex(nextActiveIndex >= 0 ? nextActiveIndex : 0)
    } else if (activeIndex >= rows.length) {
      setActiveIndex(Math.max(0, rows.length - 1))
    }
    previousRowsRef.current = rows
  }, [repository.graphRows])

  const setPinned = useCallback((oid: string, reason: GraphPinReason, pinned: boolean) => {
    const key = `${reason}:${oid}`
    setPins((current) => {
      const next = new Set(current)
      if (pinned) next.add(key)
      else next.delete(key)
      return next.size === current.size && [...next].every((value) => current.has(value))
        ? current
        : next
    })
  }, [])

  const focusIndex = useCallback(
    (index: number) => {
      setActiveIndex(index)
      virtualizer.scrollToIndex(index, { align: 'auto' })
      let attempts = 0
      const focus = () => {
        const disclosure = graphBodyRef.current?.querySelector<HTMLButtonElement>(
          `[data-graph-index="${index}"] [data-graph-disclosure]`,
        )
        if (disclosure != null) {
          disclosure.focus()
          return
        }
        attempts += 1
        if (attempts < 20) requestAnimationFrame(focus)
      }
      requestAnimationFrame(focus)
    },
    [virtualizer],
  )
  const handleDisclosureFocus = useCallback((index: number) => setActiveIndex(index), [])
  const handleDisclosureKeyDown = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
      const next = nextGraphFocusIndex(index, event.key, repository.graphRows.length)
      if (next == null || next === index) return
      event.preventDefault()
      focusIndex(next)
    },
    [focusIndex, repository.graphRows.length],
  )
  const handlePinChange = useCallback(
    (oid: string, reason: GraphPinReason, pinned: boolean) => setPinned(oid, reason, pinned),
    [setPinned],
  )

  return (
    <section data-pane="graph" className="section min-h-0 overflow-hidden md:flex md:flex-col">
      <PaneSectionHeader
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-only"
              aria-label="Refresh Graph"
              title="Refresh Graph"
              className={CHROME_ICON_BUTTON_CLASS}
              disabled={repository.graphLoading}
              onClick={() => void repository.refreshGraph()}
            >
              <IconRefresh className="size-4 md:size-3" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-only"
                  aria-label="Graph actions"
                  title="Graph actions"
                  className={CHROME_ICON_BUTTON_CLASS}
                >
                  <IconEllipsis className="size-4 md:size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem selected={view === 'tree'} onSelect={() => setView('tree')}>
                  Show as Tree
                </DropdownMenuItem>
                <DropdownMenuItem selected={view === 'list'} onSelect={() => setView('list')}>
                  Show as List
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!repository.graphHasMore || repository.graphLoading}
                  onSelect={() => void repository.loadMoreGraph()}
                >
                  Load more commits
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        count={graphCount}
        countTitle={
          graphCount == null
            ? repository.graphCountLoading
              ? 'Counting commits in Graph'
              : undefined
            : `${graphCount} commits in Graph`
        }
        dataSection="graph"
        headerRef={headerRef}
        icon={IconBranch}
        open={open}
        title="Graph"
        onOpenChange={onOpenChange}
      />
      {open && (
        <TooltipProvider delayDuration={500} skipDelayDuration={150}>
          <div
            ref={graphBodyRef}
            data-pane-body="graph"
            className="graph-list gitna-scrollbar min-h-0 px-2 pb-4 overscroll-contain md:flex-1 md:overflow-y-auto max-md:overflow-visible"
            onKeyDownCapture={(event) => {
              if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) armContinuation()
            }}
            onTouchStart={armContinuation}
            onWheel={armContinuation}
          >
            <div
              ref={virtualizer.containerRef}
              role="list"
              aria-label="Commits"
              aria-busy={repository.graphLoading || undefined}
              data-graph-virtual-list
              className="relative w-full"
            >
              {virtualItems.map((item) => {
                const row = repository.graphRows[item.index]
                if (row == null) return null
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    role="listitem"
                    aria-posinset={item.index + 1}
                    aria-setsize={graphSetSize}
                    className="graph-row absolute top-0 left-0 w-full"
                    data-graph-index={item.index}
                    data-graph-oid={row.commit.oid}
                    data-index={item.index}
                  >
                    <GraphCommitRow
                      disclosureTabIndex={item.index === activeIndex ? 0 : -1}
                      index={item.index}
                      laneCount={laneCount}
                      row={row}
                      view={view}
                      onConfirm={onConfirm}
                      onDisclosureFocus={handleDisclosureFocus}
                      onDisclosureKeyDown={handleDisclosureKeyDown}
                      onPinChange={handlePinChange}
                    />
                  </div>
                )
              })}
            </div>
            {repository.graphLoading && repository.graphRows.length > 0 && (
              <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                Loading more commits…
              </p>
            )}
            {repository.graphError != null && (
              <div className="space-y-1 px-2 py-2">
                <p role="alert" className="text-xs text-red-500">
                  {repository.graphError}
                </p>
                {repository.graphHasMore && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={repository.graphLoading}
                    onClick={() => void repository.loadMoreGraph()}
                  >
                    Retry loading commits
                  </Button>
                )}
              </div>
            )}
          </div>
        </TooltipProvider>
      )}
    </section>
  )
}

function GraphLaneGutter({
  laneCount,
  open,
  row,
}: {
  laneCount: number
  open: boolean
  row: GraphRow
}) {
  const width = graphColumnX(laneCount - 1) + GRAPH_LANE_INSET
  const nodeX = graphColumnX(row.column)
  const middle = GRAPH_ROW_HEIGHT / 2
  return (
    <svg
      aria-hidden="true"
      data-graph-gutter
      className="h-7 shrink-0"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
    >
      {row.lanes.map((lane) => {
        const laneX = graphColumnX(lane.column)
        const color = graphLaneColor(lane.column)
        return lane.next === row.commit.oid ? (
          <path
            key={`incoming:${lane.column}`}
            data-graph-segment
            d={`M ${laneX} 0 C ${laneX} ${middle / 2}, ${nodeX} ${middle / 2}, ${nodeX} ${middle}`}
            fill="none"
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <line
            key={`passing:${lane.column}`}
            data-graph-segment
            x1={laneX}
            x2={laneX}
            y1="0"
            y2={GRAPH_ROW_HEIGHT}
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
      {row.outgoing.map((column) => {
        const outgoingX = graphColumnX(column)
        return column === row.column ? (
          <line
            key={`outgoing:${column}`}
            data-graph-segment
            x1={nodeX}
            x2={nodeX}
            y1={middle}
            y2={GRAPH_ROW_HEIGHT}
            stroke={graphLaneColor(column)}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <path
            key={`outgoing:${column}`}
            data-graph-segment
            d={`M ${nodeX} ${middle} C ${nodeX} ${middle + middle / 2}, ${outgoingX} ${middle + middle / 2}, ${outgoingX} ${GRAPH_ROW_HEIGHT}`}
            fill="none"
            stroke={graphLaneColor(column)}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
      <circle
        data-graph-node
        cx={nodeX}
        cy={middle}
        r="4"
        fill={
          open ? graphLaneColor(row.column) : 'var(--diffshub-sidebar-bg, var(--color-background))'
        }
        stroke={graphLaneColor(row.column)}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

const GraphCommitRow = memo(function GraphCommitRow({
  disclosureTabIndex,
  index,
  laneCount,
  row,
  view,
  onConfirm,
  onDisclosureFocus,
  onDisclosureKeyDown,
  onPinChange,
}: {
  disclosureTabIndex: number
  index: number
  laneCount: number
  row: GraphRow
  view: RepositoryViewMode
  onConfirm(confirm: PendingConfirm): void
  onDisclosureFocus(index: number): void
  onDisclosureKeyDown(index: number, event: ReactKeyboardEvent<HTMLElement>): void
  onPinChange(oid: string, reason: GraphPinReason, pinned: boolean): void
}) {
  const repository = useRepository()
  const open = repository.expanded[row.commit.oid] === true
  const shortOid = row.commit.oid.slice(0, 8)
  const files = repository.commitFiles[row.commit.oid]
  const stats = repository.commitStats[row.commit.oid]
  const source = useMemo(
    () =>
      view === 'tree'
        ? createTreeSource(files ?? [])
        : createRepositoryListSource(
            (files ?? []).map((file) => file.path),
            files ?? [],
          ),
    [files, view],
  )
  const [treeModel, setTreeModel] = useState<FileTree | null>(null)
  const [commitOidCopied, setCommitOidCopied] = useState(false)
  const treeHeight = useNaturalTreeHeight(treeModel)
  const selectedPath =
    repository.commitDiff?.oid === row.commit.oid ? repository.commitDiff.path : null
  const refs = row.commit.refs.filter(
    (ref, index, all) => all.findIndex((candidate) => candidate.name === ref.name) === index,
  )
  const visibleRefs = refs.slice(0, 2)
  const authorTime = new Date(row.commit.authorTime)
  return (
    <div
      className="graph-row-content"
      onKeyDownCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-graph-disclosure]') != null) {
          onDisclosureKeyDown(index, event)
        }
      }}
    >
      <div className="group flex h-7 items-center gap-1 text-xs">
        <Tooltip
          onOpenChange={(tooltipOpen) => {
            onPinChange(row.commit.oid, 'tooltip', tooltipOpen)
            if (tooltipOpen) void repository.loadCommitDetails(row.commit.oid)
          }}
        >
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded px-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--diffshub-primary-fg)]',
                open && 'bg-muted',
              )}
              id={`gitna-graph-disclosure-${row.commit.oid}`}
              data-graph-disclosure
              aria-controls={`gitna-graph-files-${row.commit.oid}`}
              aria-expanded={open}
              tabIndex={disclosureTabIndex}
              onClick={() => void repository.toggleCommit(row.commit.oid)}
              onFocus={() => onDisclosureFocus(index)}
            >
              <GraphLaneGutter laneCount={laneCount} open={open} row={row} />
              <span className="min-w-0 flex-1 truncate font-medium">{row.commit.subject}</span>
              {visibleRefs.map((ref) => (
                <span
                  key={`${ref.kind}:${ref.name}`}
                  className={cn(
                    'max-w-24 shrink-0 truncate rounded-full border border-blue-500/60 px-1.5 py-0.5 text-[10px] leading-none',
                    ref.kind === 'head' ? 'bg-blue-500 text-white' : 'bg-blue-500/10 text-blue-500',
                  )}
                >
                  {ref.name}
                </span>
              ))}
              {refs.length > visibleRefs.length && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  +{refs.length - visibleRefs.length}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="start">
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
              <strong className="font-medium">{row.commit.authorName}</strong>
              <span className="text-muted-foreground">
                {relativeCommitTime(row.commit.authorTime)} ({authorTime.toLocaleString()})
              </span>
            </div>
            <p className="mt-2 font-medium">{row.commit.subject}</p>
            {refs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {refs.map((ref) => (
                  <span
                    key={`${ref.kind}:${ref.name}`}
                    className="rounded-full border border-border px-1.5 py-0.5 text-[10px]"
                  >
                    {ref.name}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-[11px]">
              {stats == null ? (
                <span className="text-muted-foreground">
                  {repository.filesError[row.commit.oid] ?? 'Loading statistics…'}
                </span>
              ) : (
                <>
                  <span className="text-muted-foreground">
                    {stats.files} {stats.files === 1 ? 'file' : 'files'}
                  </span>
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    +{stats.additions}
                  </span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    −{stats.deletions}
                  </span>
                  {stats.binaryFiles > 0 && (
                    <span className="text-muted-foreground">
                      {stats.binaryFiles} {stats.binaryFiles === 1 ? 'binary' : 'binaries'}
                    </span>
                  )}
                </>
              )}
              <button
                type="button"
                className="ml-auto cursor-pointer rounded-sm px-1 font-mono text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={
                  commitOidCopied ? `Copied commit ID ${shortOid}` : `Copy commit ID ${shortOid}`
                }
                aria-live="polite"
                title="Copy full commit ID"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(row.commit.oid)
                    .then(() => {
                      setCommitOidCopied(true)
                      window.setTimeout(() => setCommitOidCopied(false), 1500)
                    })
                    .catch(() => undefined)
                }}
              >
                {commitOidCopied ? 'Copied!' : shortOid}
              </button>
            </div>
          </TooltipContent>
        </Tooltip>
        <DropdownMenu
          onOpenChange={(menuOpen) => {
            if (menuOpen) onDisclosureFocus(index)
            onPinChange(row.commit.oid, 'menu', menuOpen)
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-only"
              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
              aria-label={`Actions for ${row.commit.subject}`}
              title={`Actions for ${row.commit.subject}`}
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
        <div
          id={`gitna-graph-files-${row.commit.oid}`}
          data-graph-files
          aria-labelledby={`gitna-graph-disclosure-${row.commit.oid}`}
          className="border-l-2 pl-1"
          style={{
            borderColor: graphLaneColor(row.column),
            marginLeft: graphColumnX(row.column) + 3,
          }}
        >
          {repository.filesLoading[row.commit.oid] && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          )}
          {files != null && files.length > 0 && (
            <div className="min-h-0" style={{ height: treeHeight }}>
              <DiffsHubFileTree
                className="overflow-visible md:ml-1"
                modelId={`gitna-graph-${row.commit.oid}`}
                onModelReady={setTreeModel}
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
})

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
      <label htmlFor="gitna-tag-remote" className="mb-3 grid gap-1 text-xs">
        Push to
        <Input
          id="gitna-tag-remote"
          aria-label="Push to"
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
        className="h-9 cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-[var(--diffshub-primary-fg)]"
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
