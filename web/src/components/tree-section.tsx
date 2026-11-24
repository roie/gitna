import { IconSearch } from '@pierre/icons'
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree,
  FileTreeDragAndDropConfig,
  FileTreeOptions,
  GitStatus,
  GitStatusEntry,
} from '@pierre/trees'
import { useFileTreeSearch } from '@pierre/trees/react'
import { type ComponentType, type CSSProperties, type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeKind } from '../lib/types'
import { Button } from './ui/button'
import { CHROME_ICON_BUTTON_CLASS } from './ui/button-styles'
import { DropdownMenuTrigger } from './ui/dropdown-menu'
import { cn } from '../lib/cn'
import { CODE_VIEW_FILE_TREE_SEARCH_OPEN_HEIGHT } from '../lib/code-view'
import { Tree, TREE_CSS } from './tree'
import type { FileTreeSource } from '../lib/review-types'
import { Header } from './ui/header'

export interface PendingConfirm {
  confirmLabel: string
  message: string
  run: () => Promise<void>
  title: string
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function trimDirectoryPath(path: string): string {
  return path.replace(/\/$/, '')
}

export interface TreeFile {
  kind: ChangeKind
  oldPath?: string
  path: string
}

export type RepositoryViewMode = 'tree' | 'list'

export function gitStatus(kind: ChangeKind): GitStatus {
  if (kind === 'added') return 'added'
  if (kind === 'untracked') return 'untracked'
  if (kind === 'deleted') return 'deleted'
  if (kind === 'renamed') return 'renamed'
  return 'modified'
}

export function createRepositoryListSource(
  paths: readonly string[],
  changes: readonly TreeFile[],
  ignored: ReadonlySet<string>,
): FileTreeSource {
  const statusesByPath = new Map<string, GitStatus>([
    ...[...ignored].map((path) => [path, 'ignored'] as const),
    ...changes.map((change) => [change.path, gitStatus(change.kind)] as const),
  ])
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

export function createTreeSource(files: readonly TreeFile[]): FileTreeSource {
  const byPath = new Map<string, TreeFile>()
  for (const file of files) byPath.set(file.path, file)
  const paths = [...byPath.keys()].sort()
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

function treeViewportHeight(source: FileTreeSource): number {
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

export function FileTreeContextMenuTrigger({ context }: { context: ContextMenuOpenContext }) {
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
  icon: ComponentType<{ className?: string }>
  modelId: string
  lazyDirectories?: ReadonlySet<string>
  knownEmptyDirectories?: ReadonlySet<string>
  pagedDirectories?: ReadonlySet<string>
  onLoadDirectory?: (path: string) => Promise<readonly string[] | null>
  onLoadMoreDirectory?: (path: string) => Promise<readonly string[] | null>
  onOpenChange: (open: boolean) => void
  onSelectPath: (path: string) => void
  onSelectPaths?: (paths: readonly string[]) => void
  open: boolean
  pane?: boolean
  renderContextMenu?: (
    item: ContextMenuItem,
    context: ContextMenuOpenContext,
    selectedPaths: readonly string[],
  ) => ReactNode
  renderHeaderActions?: (model: FileTree | null) => ReactNode
  renderRowActions?: FileTreeOptions['renderRowActions']
  selectedPath?: string | null
  selectedPaths?: readonly string[]
  source: FileTreeSource
  title: string
  titleAccessory?: ReactNode
}

export function TreeSection({
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
  knownEmptyDirectories,
  pagedDirectories,
  modelId,
  onLoadDirectory,
  onLoadMoreDirectory,
  onOpenChange,
  onSelectPath,
  onSelectPaths,
  open,
  pane = false,
  renderContextMenu,
  renderHeaderActions,
  renderRowActions,
  selectedPath,
  selectedPaths,
  source,
  title,
  titleAccessory,
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
        !pane &&
          'relative border-t border-transparent before:absolute before:inset-x-0 before:-top-px before:h-px before:bg-border first:border-t-0 first:before:hidden md:before:right-1.5 md:before:left-3',
        !pane && !fill && 'shrink-0',
        fill && open && 'md:flex md:min-h-14 md:flex-1 md:flex-col md:overflow-hidden',
        pane && 'flex h-full min-h-0 flex-col overflow-hidden',
        pane && open && 'max-md:h-[50vh]',
        pane && !open && 'max-md:h-auto',
      )}
    >
      {pane ? (
        <Header
          level="pane"
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
          count={count === undefined ? source.pathCount : count}
          countTitle={
            countTitle ??
            `${typeof count === 'number' ? count : source.pathCount} files in ${dataSection === 'repository' ? 'Repository' : title}`
          }
          dataSection={dataSection}
          ref={headerRef}
          icon={icon}
          open={open}
          title={title}
          accessory={titleAccessory}
          onOpenChange={onOpenChange}
        />
      ) : (
        <Header
          level="section"
          actions={headerActions}
          count={source.pathCount}
          dataSection={dataSection}
          ref={headerRef}
          icon={icon}
          open={open}
          title={title}
          onOpenChange={onOpenChange}
        />
      )}
      {open && (
        <div className="contents">
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
                <Tree
                  options={{
                    id: modelId,
                    ...(lazyDirectories == null
                      ? {}
                      : {
                          flattenEmptyDirectories: false,
                          search: false,
                          initialExpansion: 'closed',
                          unsafeCSS: TREE_CSS,
                        }),
                  }}
                  key={lazyDirectories == null ? 'complete' : 'lazy'}
                  className={cn(
                    pane ? 'h-full overflow-hidden' : fill ? 'md:h-full' : 'overflow-visible',
                    'md:ml-2',
                  )}
                  dragAndDrop={dragAndDrop}
                  lazyDirectories={lazyDirectories}
                  knownEmptyDirectories={knownEmptyDirectories}
                  pagedDirectories={pagedDirectories}
                  onLoadDirectory={onLoadDirectory}
                  onLoadMoreDirectory={onLoadMoreDirectory}
                  onModelReady={setModel}
                  onSelectItem={onSelectPath}
                  onSelectPaths={onSelectPaths}
                  renderContextMenu={renderContextMenu}
                  renderRowActions={renderRowActions}
                  selectedPath={selectedPath}
                  selectedPaths={selectedPaths}
                  source={source}
                />
              </div>
            )}
            {source.pathCount === 0 && (
              <p className="px-8 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
            )}
          </div>
          {footer != null && <div className="shrink-0">{footer}</div>}
        </div>
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
  onOpenChange: (open: boolean) => void
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
