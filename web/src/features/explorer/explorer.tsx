import { LoadingIndicator, useLoadingIndicator } from '../../components/ui/loading'
import { filterFileTreeSource } from '../../lib/tree-source'
import { EntryDialog } from './entry-dialog'
import { IconEllipsis, IconFileTree, IconFilter, IconRefresh, IconXSquircle } from '@pierre/icons'
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeDirectoryHandle,
  GitStatus,
} from '@pierre/trees'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeScope } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { CHROME_ICON_BUTTON_CLASS } from '../../components/ui/button-styles'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { cn } from '../../lib/cn'
import type { FileTreeSource } from '../../lib/review-types'
import { expandRepositoryFolders } from './expand-repository-folders'
import { useRepository } from '../../repository/repository'
import {
  trimDirectoryPath,
  TreeSection,
  message,
  createTreeSource,
  createRepositoryListSource,
  type TreeFile,
  type RepositoryViewMode,
  gitStatus,
  FileTreeContextMenuTrigger,
} from '../../components/tree-section'

export function repositoryName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
}

function repositoryItemParent(item: ContextMenuItem): string {
  if (item.kind === 'directory') return `${trimDirectoryPath(item.path)}/`
  const separator = item.path.lastIndexOf('/')
  return separator < 0 ? '' : item.path.slice(0, separator + 1)
}

export function repositoryDropDestination(source: string, directoryPath: string | null): string {
  const normalizedSource = trimDirectoryPath(source)
  const name = normalizedSource.slice(normalizedSource.lastIndexOf('/') + 1)
  const directory = directoryPath == null ? '' : trimDirectoryPath(directoryPath)
  return directory.length === 0 ? name : `${directory}/${name}`
}

export function isHiddenRepositoryPath(path: string): boolean {
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
    color: 'var(--gitna-git-added)',
  },
  {
    status: 'modified',
    label: 'Modified',
    short: 'M',
    color: 'var(--gitna-git-modified)',
  },
  {
    status: 'untracked',
    label: 'Untracked',
    short: 'U',
    color: 'var(--gitna-git-untracked)',
  },
  {
    status: 'renamed',
    label: 'Renamed',
    short: 'R',
    color: 'var(--gitna-git-renamed)',
  },
  {
    status: 'deleted',
    label: 'Deleted',
    short: 'D',
    color: 'var(--gitna-git-deleted)',
  },
]

export function createRepositoryTreeSource(
  paths: readonly string[],
  changes: readonly TreeFile[],
  ignored: ReadonlySet<string>,
): FileTreeSource {
  const identity = new Map(paths.filter((path) => !path.endsWith('/')).map((path) => [path, path]))
  return {
    gitStatus: [
      ...changes.map((change) => ({ path: change.path, status: gitStatus(change.kind) })),
      ...paths
        .filter((path) => ignored.has(path))
        .map((path) => ({ path, status: 'ignored' as const })),
    ],
    pathCount: paths.length,
    paths,
    pathToItemId: identity,
    itemIdToPath: identity,
  }
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

export function RepositoryContextMenu({
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
  onReveal,
}: {
  changeScopes: readonly ChangeScope[]
  compareSelected: boolean
  context: ContextMenuOpenContext
  item: ContextMenuItem
  onCompareSelected: () => void
  onCopyPath: (path: string) => void
  onCreate: (kind: 'file' | 'folder', initialPath: string) => void
  onOpen: (path: string) => void
  onOpenChange: (scope: ChangeScope, path: string) => void
  onRefresh: () => void
  onRename: (source: string) => void
  onReveal: (path: string) => void
}) {
  const repository = useRepository()
  const disabledReason = repository.getActionDisabledReason()
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
          disabled={disabledReason != null}
          onSelect={() => {
            context.close()
            onReveal(item.path)
          }}
        >
          Reveal in File Manager
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={disabledReason != null}
          onSelect={() => {
            closeForDialog()
            onCreate('file', repositoryItemParent(item))
          }}
        >
          New File
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabledReason != null}
          onSelect={() => {
            closeForDialog()
            onCreate('folder', repositoryItemParent(item))
          }}
        >
          New Folder
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabledReason != null}
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

export function RepositoryHeaderActions({
  availableStatuses,
  repositoryMode,
  loading,
  refreshing,
  model,
  onClearFilters,
  onCreate,
  onFindInFiles,
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
  refreshing: boolean
  model: FileTree | null
  onClearFilters: () => void
  onCreate: (kind: 'file' | 'folder', initialPath: string) => void
  onFindInFiles?: () => void
  onIsolateFilter: (status: GitStatus) => void
  onRefresh: () => void
  onRename: (source: string) => void
  onShowHiddenFilesChange: (show: boolean) => void
  onShowIgnoredFilesChange: (show: boolean) => void
  onToggleFilter: (status: GitStatus) => void
  onViewChange: (view: RepositoryViewMode) => void
  paths: readonly string[]
  selectedStatuses: ReadonlySet<GitStatus>
  showHiddenFiles: boolean
  showIgnoredFiles: boolean
  view: RepositoryViewMode
}) {
  const repository = useRepository()
  const disabledReason = repository.getActionDisabledReason()
  const cancelExpansion = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cancelExpansion.current?.()
      cancelExpansion.current = null
    },
    [model, view, repository.snapshot?.root],
  )
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  useEffect(() => {
    const update = () => {
      const path = model?.getSelectedPaths()[0]
      setRenameTarget(path != null && model?.getItem(path) != null ? path : null)
    }
    update()
    return model?.subscribe(update)
  }, [model])
  const filtered = selectedStatuses.size > 0
  const visibleFilters = REPOSITORY_FILTERS.filter(({ status }) => availableStatuses.has(status))
  const [isMac] = useState(
    () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform),
  )
  const altKeyRef = useRef(false)
  return (
    <>
      {repositoryMode && visibleFilters.length > 0 && (
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
                  className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-[1px] border-[var(--gitna-sidebar-bg)] bg-highlight"
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
        aria-label={loading ? 'Refreshing Explorer' : 'Refresh Explorer'}
        title={loading ? 'Refreshing Explorer' : 'Refresh Explorer'}
        disabled={loading}
        onClick={onRefresh}
      >
        <IconRefresh
          className={cn(
            'size-4 motion-reduce:animate-none md:size-3',
            refreshing && 'animate-spin',
          )}
        />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-only"
            className={CHROME_ICON_BUTTON_CLASS}
            aria-label="Explorer actions"
            data-menu-focus-fallback
            title="Explorer actions"
          >
            <IconEllipsis className="size-4 md:size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onFindInFiles != null && (
            <>
              <DropdownMenuItem onSelect={onFindInFiles}>
                Find in Files
                <DropdownMenuShortcut className="pl-6 tracking-normal">
                  {isMac ? '⇧⌘F' : 'Ctrl+Shift+F'}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            disabled={disabledReason != null}
            onSelect={() => onCreate('file', repositoryCreationParent(model))}
          >
            New File
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={disabledReason != null}
            onSelect={() => onCreate('folder', repositoryCreationParent(model))}
          >
            New Folder
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={renameTarget == null || disabledReason != null}
            onSelect={() => {
              if (renameTarget != null) onRename(renameTarget)
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
            onSelect={() => {
              cancelExpansion.current?.()
              if (model != null) cancelExpansion.current = expandRepositoryFolders(model)
            }}
          >
            Expand all folders
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={view !== 'tree' || model == null}
            onSelect={() => {
              cancelExpansion.current?.()
              cancelExpansion.current = null
              setRepositoryFoldersExpanded(model, paths, false)
            }}
          >
            Collapse all folders
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

type RepositoryEntryDialog =
  | { kind: 'file' | 'folder'; initialPath: string }
  | { kind: 'rename'; initialPath: string; source: string }
  | null

export function Explorer({
  snapshot,
  open: repositoryOpen,
  onOpenChange: setRepositoryOpen,
  onFindInFiles,
  onError: setLocalError,
  run,
}: {
  snapshot: NonNullable<ReturnType<typeof useRepository>['snapshot']>
  open: boolean
  onOpenChange: (open: boolean) => void
  onFindInFiles?: () => void
  onError: (error: string | null) => void
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const repository = useRepository()
  const [repositoryFilters, setRepositoryFilters] = useState<ReadonlySet<GitStatus>>(
    () => new Set(),
  )
  const [repositoryView, setRepositoryView] = useState<RepositoryViewMode>('tree')
  const [showHiddenFiles, setShowHiddenFiles] = useState(true)
  const [showIgnoredFiles, setShowIgnoredFiles] = useState(true)
  const [repositoryEntryDialog, setRepositoryEntryDialog] = useState<RepositoryEntryDialog>(null)
  const connectionHealthy = repository.connectionState === 'connected'
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const repositoryRefreshing =
    repository.repositoryFilesLoading || repository.repositoryFileCountLoading
  const repositoryRefreshVisible = useLoadingIndicator(repositoryRefreshing)
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
  const filteredChanges = useMemo(
    () =>
      activeRepositoryFilters.size === 0
        ? null
        : filterFileTreeSource(createTreeSource(repositoryChanges), activeRepositoryFilters),
    [activeRepositoryFilters, repositoryChanges],
  )
  const filteredRepositoryPaths = filteredChanges?.paths ?? visibleRepositoryPaths
  const lazyRepositoryTree = repositoryView === 'tree' && filteredChanges == null
  const repositorySource = useMemo(
    () =>
      repositoryView === 'tree'
        ? (filteredChanges ??
          createRepositoryTreeSource(
            visibleRepositoryPaths,
            repositoryChanges,
            repository.repositoryIgnoredPaths,
          ))
        : createRepositoryListSource(
            filteredRepositoryPaths,
            repositoryChanges,
            repository.repositoryIgnoredPaths,
          ),
    [
      filteredChanges,
      filteredRepositoryPaths,
      visibleRepositoryPaths,
      repositoryChanges,
      repository.repositoryIgnoredPaths,
      repositoryView,
    ],
  )
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
  const pagedOrdinaryDirectory = repository.ordinaryPagedDirectories.values().next().value
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
      setLocalError,
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
    [changeScopesForPath, repository, run, selectRepositoryPath, setLocalError],
  )

  useEffect(() => {
    if (repository.repositoryFileRevealVersion === 0) return
    setRepositoryFilters((current) => (current.size === 0 ? current : new Set()))
    setShowHiddenFiles(true)
    setShowIgnoredFiles(true)
  }, [repository.repositoryFileRevealVersion])

  return (
    <>
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
                  onClick={() => void repository.loadMoreOrdinaryDirectory(pagedOrdinaryDirectory)}
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
        lazyDirectories={lazyRepositoryTree ? repository.ordinaryUnloadedDirectories : undefined}
        knownEmptyDirectories={
          lazyRepositoryTree ? repository.ordinaryKnownEmptyDirectories : undefined
        }
        pagedDirectories={lazyRepositoryTree ? repository.ordinaryPagedDirectories : undefined}
        modelId="gitna-repository-tree"
        onLoadDirectory={lazyRepositoryTree ? loadOrdinaryDirectory : undefined}
        onLoadMoreDirectory={lazyRepositoryTree ? loadMoreOrdinaryDirectory : undefined}
        open={repositoryOpen}
        selectedPath={repository.repositoryFilePath ?? repository.selection?.change.path}
        selectedPaths={repository.repositorySelectedPaths}
        source={repositorySource}
        title={repositoryName(snapshot.root)}
        onOpenChange={setRepositoryOpen}
        onSelectPath={selectRepositoryPath}
        onSelectPaths={(paths) => repository.setRepositorySelectedPaths(paths)}
      />
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
    </>
  )
}
