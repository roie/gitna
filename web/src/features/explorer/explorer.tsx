import { IconEllipsis, IconFilter, IconRefresh, IconXSquircle } from '@pierre/icons'
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree,
  FileTreeDirectoryHandle,
  GitStatus,
} from '@pierre/trees'
import { useEffect, useRef, useState } from 'react'
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
import type { DiffsHubFileTreeSource } from '../../lib/review-types'
import { expandRepositoryFolders } from './expand-repository-folders'
import { useRepository } from '../../repository/repository'
import {
  trimDirectoryPath,
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
): DiffsHubFileTreeSource {
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
                  className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-[1px] border-[var(--diffshub-sidebar-bg)] bg-highlight"
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
