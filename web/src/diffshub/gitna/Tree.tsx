// Modified by Gitna: retain server loading, canonical selection, paging and local actions around Trees.
'use client'

import { useStableCallback } from '@pierre/diffs/react'
import { useThemeController } from '@pierre/theming/react'
import { themeToTreeStyles } from '@pierre/trees'
import type {
  FileTreeBatchOperation,
  FileTreeChildLoadAttempt,
  FileTree as FileTreeModel,
  FileTreeDirectoryHandle,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeOptions,
} from '@pierre/trees'
import { type FileTreeProps, useFileTree, FileTree } from '@pierre/trees/react'
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { themeController } from './ThemeRoot'
import { deriveChromeTokens } from '../lib/theme/deriveChromeTokens'
import { CODE_VIEW_FILE_TREE_ITEM_HEIGHT, getInitialBatchSize } from '@/lib/constants'
import { cn } from '@/lib/cn'
import type { DiffsHubFileTreeSource } from '@/lib/types'
type FileTreePublicId = string
type FileTreeSortComparator = Exclude<NonNullable<FileTreeOptions['sort']>, 'default'>
const PRESERVE_INPUT_ORDER_SORT: FileTreeSortComparator = () => 0
const PATH_ORDER_SORT: FileTreeSortComparator = (left, right) => {
  const key = ({ path, isDirectory }: Parameters<FileTreeSortComparator>[0]) =>
    isDirectory && !path.endsWith('/') ? `${path}/` : path
  const [a, b] = [key(left), key(right)]
  return a < b ? -1 : a > b ? 1 : 0
}

export function buildLazyPathReconciliationOperations(
  appliedPaths: ReadonlySet<string>,
  nextPaths: ReadonlySet<string>,
): FileTreeBatchOperation[] {
  const operations: FileTreeBatchOperation[] = []
  const removedPaths = [...appliedPaths].filter((path) => !nextPaths.has(path)).sort()
  let coveringDirectory: string | null = null
  for (const path of removedPaths) {
    if (coveringDirectory != null && path.startsWith(coveringDirectory)) continue
    coveringDirectory = null
    operations.push({ type: 'remove', path, recursive: path.endsWith('/') })
    if (path.endsWith('/')) coveringDirectory = path
  }
  const addedPaths = [...nextPaths].filter((path) => !appliedPaths.has(path)).sort()
  for (const path of addedPaths) operations.push({ type: 'add', path })
  return operations
}

export function filterAlreadyAppliedLazyOperations(
  operations: readonly FileTreeBatchOperation[],
  hasPath: (path: string) => boolean,
): FileTreeBatchOperation[] {
  return operations.filter((operation) => {
    if (operation.type === 'remove') return hasPath(operation.path)
    if (operation.type === 'add') return !hasPath(operation.path)
    return true
  })
}
export function resolveFileTreeContextSelection(
  selectedPaths: readonly string[],
  contextPath: string,
): readonly string[] {
  return selectedPaths.includes(contextPath) ? selectedPaths : [contextPath]
}

export function applyLazyDirectoryChildren(
  model: FileTreeModel,
  attempt: FileTreeChildLoadAttempt,
  prefix: string,
  children: readonly string[],
  appliedPaths: Set<string>,
): boolean {
  const operations: FileTreeBatchOperation[] = []
  const nextChildren = new Set(children)
  for (const existing of appliedPaths) {
    if (!existing.startsWith(prefix)) continue
    const remainder = existing.slice(prefix.length).replace(/\/$/, '')
    if (remainder === '' || remainder.includes('/')) continue
    if (!nextChildren.has(existing)) {
      operations.push({ type: 'remove', path: existing, recursive: existing.endsWith('/') })
    }
  }
  for (const child of children) {
    if (!appliedPaths.has(child)) operations.push({ type: 'add', path: child })
  }
  if (!model.applyChildPatch(attempt, { operations })) return false
  for (const operation of operations) {
    if (operation.type === 'add') {
      appliedPaths.add(operation.path)
      continue
    }
    if (operation.type !== 'remove') continue
    for (const applied of appliedPaths) {
      if (
        applied === operation.path ||
        (operation.recursive === true &&
          operation.path.endsWith('/') &&
          applied.startsWith(operation.path))
      ) {
        appliedPaths.delete(applied)
      }
    }
  }
  return true
}
export function beginLazyDirectoryLoad(
  model: FileTreeModel,
  path: string,
): FileTreeChildLoadAttempt | null {
  const state = model.getDirectoryLoadState(path)
  if (state !== 'unloaded' && state !== 'error') return null
  return model.beginChildLoad(path)
}
export function settleKnownEmptyDirectory(model: FileTreeModel, path: string): boolean {
  const item = model.getItem(path)
  if (item == null || !item.isDirectory() || model.getDirectoryLoadState(path) === 'loaded') {
    return false
  }
  const attempt = model.beginChildLoad(path)
  if (!model.applyChildPatch(attempt, { operations: [] })) return false
  return model.completeChildLoad(attempt)
}
export function resetLazyDirectory(model: FileTreeModel, path: string): void {
  const expanded = (model.getItem(path) as FileTreeDirectoryHandle).isExpanded()
  model.batch([
    { type: 'remove', path, recursive: true },
    { type: 'add', path },
  ])
  model.markDirectoryUnloaded(path)
  if (expanded) (model.getItem(path) as FileTreeDirectoryHandle).expand()
}

const HIDDEN_SEARCH_UNSAFE_CSS = `
  [data-file-tree-search-container][data-open='false'] {
    display: none;
  }
  [data-file-tree-search-container] {
    padding-bottom: 12px;
    margin-bottom: 12px;
    margin-right: 4px;
    border-bottom: 1px solid var(--color-border);
    padding-inline-start: 1px;
    padding-inline-end: 5px;
  }

  [data-file-tree-sticky-overlay-content] {

    [data-item-section="spacing"] {
      opacity: 0.5;
    }

    > [data-file-tree-sticky-path]:last-of-type {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;

      [data-item-section="spacing"] {
        margin-bottom: 4px;
      }
    }
  }

  @media (prefers-color-scheme: dark) {
    [data-file-tree-sticky-overlay-content] {

      [data-item-section="spacing"] {
        opacity: 0.6;
      }
    }
  }
`

const SIDEBAR_VIRTUALIZED_SCROLL_UNSAFE_CSS = `
  [data-file-tree-virtualized-scroll="true"] {
    padding-inline-start: 0;
    padding-inline-end: 2px;
    margin-inline-end: 2px;
  }

  @media (width <= 767px) {
    [data-file-tree-search-container="true"],
    [data-file-tree-virtualized-scroll="true"] {
      padding-inline-start: 14px;
    }

    [data-file-tree-search-container="true"] {
      margin-right: 0;
      padding-inline-end: 14px;
    }

    [data-file-tree-virtualized-scroll="true"] {
      padding-inline-end: max(0px, calc(14px - var(--trees-scrollbar-gutter)));
    }
  }
`

const SUPPRESS_FOLDER_DOT_UNSAFE_CSS = `
  [data-item-contains-git-change='true'] > [data-item-section='git'] {
    display: none;
  }
`

const FILE_TREE_ACTION_SPRITE_SHEET = `
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">
  <symbol id="gitna-action-stage" viewBox="0 0 16 16"><path d="M7 3h2v4h4v2H9v4H7V9H3V7h4z" /></symbol>
  <symbol id="gitna-action-unstage" viewBox="0 0 16 16"><path d="M3 7h10v2H3z" /></symbol>
  <symbol id="gitna-action-discard" viewBox="0 0 16 16"><path d="M6 3v2h4a4 4 0 1 1 0 8H8v-2h2a2 2 0 1 0 0-4H6v2L2 6l4-4v1z" /></symbol>
  <symbol id="gitna-action-open-file" viewBox="0 0 16 16"><path d="M3 2h7l3 3v9H3V2zm2 2v8h6V6H9V4H5zm1 3h4v1.5H6V7zm0 2.5h4V11H6V9.5z" /></symbol>
</svg>`

export const TREE_CSS = `${HIDDEN_SEARCH_UNSAFE_CSS}\n${SIDEBAR_VIRTUALIZED_SCROLL_UNSAFE_CSS}`

const DENSITY_OVERRIDE_STYLES = {
  '--trees-padding-inline-override': 8,
  '--trees-git-renamed-color-override': 'light-dark(#007aff, #007aff)',
} as CSSProperties

interface TreeProps {
  options: Omit<FileTreeOptions, 'paths' | 'preparedInput'>
  style?: CSSProperties
  className?: string
  dragAndDrop?: FileTreeDragAndDropConfig
  lazyDirectories?: ReadonlySet<string>
  knownEmptyDirectories?: ReadonlySet<string>
  pagedDirectories?: ReadonlySet<string>
  onLoadDirectory?: (path: string) => Promise<readonly string[] | null>
  onLoadMoreDirectory?: (path: string) => Promise<readonly string[] | null>
  onModelReady?: (model: FileTreeModel | null) => void
  onSelectItem: (itemId: string) => void
  onSelectPaths?: (paths: readonly string[]) => void
  renderContextMenu?: (
    item: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[0],
    context: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[1],
    selectedPaths: readonly string[],
  ) => ReactNode
  renderRowActions?: FileTreeOptions['renderRowActions']
  selectedPath?: string | null
  selectedPaths?: readonly string[]
  source: DiffsHubFileTreeSource
}

export const Tree = memo(function Tree({
  options,
  style,
  className,
  dragAndDrop,
  lazyDirectories,
  knownEmptyDirectories,
  pagedDirectories,
  onLoadDirectory,
  onLoadMoreDirectory,
  onModelReady,
  onSelectItem,
  onSelectPaths,
  renderContextMenu,
  renderRowActions,
  selectedPath,
  selectedPaths,
  source,
}: TreeProps) {
  const { resolvedTheme } = useThemeController(themeController)
  const themeStyle = useMemo(() => {
    if (resolvedTheme == null) return {}
    const result = themeToTreeStyles(resolvedTheme)
    const colors = resolvedTheme.colors ?? {}
    const foreground = deriveChromeTokens(resolvedTheme)?.fg
    if (foreground != null && foreground !== '' && foreground !== colors['sideBar.foreground']) {
      result.color = foreground
      result['--trees-theme-sidebar-fg'] = foreground
      if (colors['sideBarSectionHeader.foreground'] == null)
        result['--trees-theme-sidebar-header-fg'] = foreground
      if (colors['list.activeSelectionForeground'] == null)
        result['--trees-theme-list-active-selection-fg'] = foreground
      if (
        colors['list.focusOutline'] == null &&
        colors['focusBorder'] == null &&
        colors['sideBar.foreground'] == null
      )
        result['--trees-theme-focus-ring'] = foreground
    }
    return result
  }, [resolvedTheme])
  const loadingMoreDirectoriesRef = useRef(new Set<string>())
  const syncingSelectionRef = useRef(false)
  const previousSourceRef = useRef(source)
  const revealedSelectionRef = useRef<{ model: FileTreeModel; path: string } | null>(null)
  const [initialVisibleRowCount] = useState(getInitialBatchSize)
  const initialPathsRef = useRef<readonly string[] | null>(null)
  initialPathsRef.current ??= source.paths.slice(0, source.pathCount)
  const appliedPathsRef = useRef(new Set(initialPathsRef.current))
  const onSelectionChange = useStableCallback((modelSelectedPaths: readonly FileTreePublicId[]) => {
    if (syncingSelectionRef.current || onSelectItem == null) return
    const canonicalPaths = modelSelectedPaths.map((path) => source.pathToItemId.get(path) ?? path)
    onSelectPaths?.(canonicalPaths)
    if (canonicalPaths.length === 0 && onSelectPaths == null && selectedPath != null) {
      onSelectItem(selectedPath)
      return
    }
    if (canonicalPaths.length !== 1) return
    onSelectItem(canonicalPaths[0])
  })

  const stableCanDrag = useStableCallback((paths: readonly string[]) => {
    return dragAndDrop?.canDrag?.(paths) ?? true
  })
  const stableCanDrop = useStableCallback((event: FileTreeDropContext) => {
    return dragAndDrop?.canDrop?.(event) ?? true
  })
  const stableOnDropComplete = useStableCallback((event: FileTreeDropResult) => {
    dragAndDrop?.onDropComplete?.(event)
  })
  const stableOnDropError = useStableCallback((error: string, event: FileTreeDropContext) => {
    dragAndDrop?.onDropError?.(error, event)
  })

  const handleClickCapture = useStableCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      selectedPath == null
    )
      return
    const row = event.nativeEvent
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.type === 'item',
      )
    const rowPath = row?.dataset.itemPath
    if (rowPath == null) return
    const canonicalPath = source.pathToItemId.get(rowPath) ?? rowPath
    if (canonicalPath === selectedPath) onSelectItem(canonicalPath)
  })

  const stableRenderContextMenu = useStableCallback(
    (
      item: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[0],
      context: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[1],
    ) => {
      let modelSelectedPaths = model.getSelectedPaths()
      const contextSelection = resolveFileTreeContextSelection(modelSelectedPaths, item.path)
      if (contextSelection !== modelSelectedPaths) {
        syncingSelectionRef.current = true
        for (const path of modelSelectedPaths) model.getItem(path)?.deselect()
        model.getItem(item.path)?.select()
        syncingSelectionRef.current = false
        modelSelectedPaths = contextSelection
        onSelectPaths?.([source.pathToItemId.get(item.path) ?? item.path])
      }
      const canonicalPath = source.pathToItemId.get(item.path) ?? item.path
      const canonicalItem = canonicalPath === item.path ? item : { ...item, path: canonicalPath }
      const canonicalSelectedPaths = modelSelectedPaths.map(
        (path) => source.pathToItemId.get(path) ?? path,
      )
      return renderContextMenu?.(canonicalItem, context, canonicalSelectedPaths) ?? null
    },
  )

  const loadMoreForPaths = useStableCallback((paths: readonly string[]) => {
    for (const rowPath of [...paths].reverse()) {
      const normalized = rowPath.replace(/\/$/, '')
      const separator = normalized.lastIndexOf('/')
      const parent = separator < 0 ? '' : normalized.slice(0, separator)
      if (pagedDirectories?.has(parent) !== true) continue
      if (loadingMoreDirectoriesRef.current.has(parent)) return
      loadingMoreDirectoriesRef.current.add(parent)
      void onLoadMoreDirectory?.(parent).finally(() => {
        loadingMoreDirectoriesRef.current.delete(parent)
      })
      return
    }
  })

  const handleWheelCapture = useStableCallback((event: ReactWheelEvent<HTMLElement>) => {
    if (event.deltaY <= 0 || pagedDirectories == null) return
    const scroller = event.nativeEvent
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.fileTreeVirtualizedScroll === 'true',
      )
    if (
      scroller == null ||
      scroller.scrollTop + scroller.clientHeight <
        scroller.scrollHeight - 12 * CODE_VIEW_FILE_TREE_ITEM_HEIGHT
    ) {
      return
    }
    const root = scroller.getRootNode()
    if (!(root instanceof ShadowRoot)) return
    const paths = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-type="item"][data-item-path]:not([data-item-parked="true"])',
      ),
    ]
      .slice(-8)
      .flatMap((row) => (row.dataset.itemPath == null ? [] : [row.dataset.itemPath]))
    loadMoreForPaths(paths)
  })

  const stableRenderRowActions = useStableCallback(
    (context: Parameters<NonNullable<FileTreeOptions['renderRowActions']>>[0]) =>
      renderRowActions?.(context) ?? null,
  )

  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    icons: { set: 'complete', spriteSheet: FILE_TREE_ACTION_SPRITE_SHEET },
    presorted: true,
    search: true,
    stickyFolders: true,
    unsafeCSS: `${TREE_CSS}\n${SUPPRESS_FOLDER_DOT_UNSAFE_CSS}`,
    density: 'compact',
    ...options,
    gitStatus: source.gitStatus,
    dragAndDrop:
      dragAndDrop == null
        ? undefined
        : {
            canDrag: stableCanDrag,
            canDrop: stableCanDrop,
            onDropComplete: stableOnDropComplete,
            onDropError: stableOnDropError,
            openOnDropDelay: dragAndDrop.openOnDropDelay,
          },
    paths: initialPathsRef.current,
    sort: lazyDirectories == null ? PRESERVE_INPUT_ORDER_SORT : PATH_ORDER_SORT,
    onSelectionChange,
    renderRowActions: stableRenderRowActions,
    itemHeight: CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
    initialVisibleRowCount,
    initialUnloadedDirectoryPaths: lazyDirectories == null ? undefined : [...lazyDirectories],
  })

  useEffect(() => {
    if (lazyDirectories == null) return
    const nextPaths = new Set(source.paths.slice(0, source.pathCount))
    const operations = filterAlreadyAppliedLazyOperations(
      buildLazyPathReconciliationOperations(appliedPathsRef.current, nextPaths),
      (path) => model.getItem(path) != null,
    )
    if (operations.length > 0) model.batch(operations)
    model.setGitStatus(source.gitStatus)
    appliedPathsRef.current = nextPaths
    for (const path of knownEmptyDirectories ?? []) settleKnownEmptyDirectory(model, path)
    for (const path of lazyDirectories) {
      if (model.getItem(path)?.isDirectory() && model.getDirectoryLoadState(path) === 'loaded') {
        resetLazyDirectory(model, path)
      }
    }
  }, [knownEmptyDirectories, lazyDirectories, model, source])

  const loadDirectory = useStableCallback((path: string) => {
    const attempt = beginLazyDirectoryLoad(model, path)
    if (attempt == null) return
    void onLoadDirectory?.(path.replace(/\/$/, ''))
      .then((children) => {
        if (children == null) {
          model.failChildLoad(attempt, 'Directory loading was canceled')
          return
        }
        if (!applyLazyDirectoryChildren(model, attempt, path, children, appliedPathsRef.current)) {
          return
        }
        for (const child of children) {
          if (
            child.endsWith('/') &&
            lazyDirectories?.has(child) === true &&
            model.getItem(child)?.isDirectory() &&
            model.getDirectoryLoadState(child) === 'loaded'
          ) {
            model.markDirectoryUnloaded(child)
          }
        }
        model.completeChildLoad(attempt)
      })
      .catch((reason: unknown) => {
        model.failChildLoad(attempt, reason instanceof Error ? reason.message : String(reason))
      })
  })

  useEffect(() => {
    if (lazyDirectories == null || onLoadDirectory == null) return
    const expanded = new Set<string>()
    return model.subscribe(() => {
      const nextExpanded = new Set<string>()
      for (const path of appliedPathsRef.current) {
        if (!path.endsWith('/')) continue
        const item = model.getItem(path)
        if (item == null || !item.isDirectory()) continue
        if (!(item as FileTreeDirectoryHandle).isExpanded()) continue
        nextExpanded.add(path)
        const wasExpanded = expanded.has(path)
        expanded.add(path)
        if (!wasExpanded && model.getDirectoryLoadState(path) !== 'loading') loadDirectory(path)
      }
      for (const path of expanded) {
        if (!nextExpanded.has(path)) expanded.delete(path)
      }
    })
  }, [model, onLoadDirectory])

  useEffect(() => {
    if (lazyDirectories != null) return
    const previousSource = previousSourceRef.current
    if (previousSource === source) {
      return
    }

    previousSourceRef.current = source
    model.resetPaths(source.paths.slice(0, source.pathCount))
    model.setGitStatus(source.gitStatus)
  }, [model, source])

  useEffect(() => {
    const fileTreeContainer = model.getFileTreeContainer()
    if (fileTreeContainer != null) model.render({ fileTreeContainer })
  }, [model, renderRowActions])

  useLayoutEffect(() => {
    onModelReady?.(model)
    return () => onModelReady?.(null)
  }, [model, onModelReady])

  useEffect(() => {
    const canonicalSelectedPaths = selectedPaths ?? (selectedPath == null ? [] : [selectedPath])
    const modelPaths = canonicalSelectedPaths.map((path) => source.itemIdToPath?.get(path) ?? path)
    const modelPathSet = new Set(modelPaths)
    syncingSelectionRef.current = true
    for (const path of model.getSelectedPaths()) {
      if (!modelPathSet.has(path)) model.getItem(path)?.deselect()
    }
    for (const modelPath of modelPaths) model.getItem(modelPath)?.select()
    const modelPath =
      selectedPath == null
        ? (modelPaths.at(-1) ?? null)
        : (source.itemIdToPath?.get(selectedPath) ?? selectedPath)
    syncingSelectionRef.current = false
    if (modelPath == null) {
      revealedSelectionRef.current = null
      return
    }
    const previousReveal = revealedSelectionRef.current
    if (previousReveal?.model === model && previousReveal.path === modelPath) return
    if (model.getItem(modelPath) == null) return
    syncingSelectionRef.current = true
    const segments = modelPath.split('/')
    let directoryPath = ''
    for (const segment of segments.slice(0, -1)) {
      directoryPath += `${segment}/`
      const item = model.getItem(directoryPath)
      if (item?.isDirectory()) (item as FileTreeDirectoryHandle).expand()
    }
    syncingSelectionRef.current = false
    let canceled = false
    queueMicrotask(() => {
      if (canceled) return
      model.scrollToPath(modelPath, { focus: false, offset: 'nearest' })
      revealedSelectionRef.current = { model, path: modelPath }
    })
    return () => {
      canceled = true
    }
  }, [model, selectedPath, selectedPaths, source])

  return (
    <FileTree
      className={cn('h-full min-h-0 overflow-auto md:ml-3', 'overscroll-contain', className)}
      model={model}
      onClickCapture={handleClickCapture}
      onWheelCapture={handleWheelCapture}
      renderContextMenu={renderContextMenu == null ? undefined : stableRenderContextMenu}
      style={{ ...themeStyle, ...DENSITY_OVERRIDE_STYLES, ...style }}
    />
  )
})
