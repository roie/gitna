'use client';

import { useStableCallback } from '@pierre/diffs/react';
import type {
  FileTreeBatchOperation,
  FileTreeChildLoadAttempt,
  FileTree as FileTreeModel,
  FileTreeDirectoryHandle,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeOptions,
} from '@pierre/trees';
import { type FileTreeProps, useFileTree } from '@pierre/trees/react';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  memo,
  useEffect,
  useRef,
  useState,
} from 'react';

// Modified from the pinned DiffsHub donor: the monorepo-private public-id
// import is replaced by its package-level string contract for standalone Vite.
type FileTreePublicId = string;
import { ThemedFileTree } from './ThemedFileTree';
import {
  BASE_FILE_TREE_OPTIONS,
  CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
  getInitialBatchSize,
  LAZY_REPOSITORY_FILE_TREE_OPTIONS,
  REPOSITORY_FILE_TREE_OPTIONS,
} from '@/lib/constants';
import { cn } from '@/lib/cn';
import type { DiffsHubFileTreeSource } from '@/lib/types';
type FileTreeSortComparator = Exclude<
  NonNullable<FileTreeOptions['sort']>,
  'default'
>;
// Keeps @pierre/trees from applying its default semantic sort so the sidebar
// follows the same patch path sequence that drives the code view.
const PRESERVE_INPUT_ORDER_SORT: FileTreeSortComparator = () => 0;

export function buildLazyPathReconciliationOperations(
  appliedPaths: ReadonlySet<string>,
  nextPaths: ReadonlySet<string>
): FileTreeBatchOperation[] {
  const operations: FileTreeBatchOperation[] = [];
  const removedPaths = [...appliedPaths].filter((path) => !nextPaths.has(path)).sort();
  let coveringDirectory: string | null = null;
  for (const path of removedPaths) {
    if (coveringDirectory != null && path.startsWith(coveringDirectory)) continue;
    coveringDirectory = null;
    operations.push({ type: 'remove', path, recursive: path.endsWith('/') });
    if (path.endsWith('/')) coveringDirectory = path;
  }
  const addedPaths = [...nextPaths].filter((path) => !appliedPaths.has(path)).sort();
  for (const path of addedPaths) operations.push({ type: 'add', path });
  return operations;
}

export function filterAlreadyAppliedLazyOperations(
  operations: readonly FileTreeBatchOperation[],
  hasPath: (path: string) => boolean
): FileTreeBatchOperation[] {
  return operations.filter((operation) => {
    if (operation.type === 'remove') return hasPath(operation.path);
    if (operation.type === 'add') return !hasPath(operation.path);
    return true;
  });
}

// Layout-only overrides. Colors flow through from the resolved Shiki theme
// (via themeToTreeStyles) so the sidebar matches the diff theme, but the
// density and padding stay tuned for the diffshub layout regardless of
// which theme the user picks. `--trees-git-renamed-color-override` is kept
// because most Shiki themes don't define a "renamed" decoration color.
export function resolveFileTreeContextSelection(
  selectedPaths: readonly string[],
  contextPath: string
): readonly string[] {
  return selectedPaths.includes(contextPath) ? selectedPaths : [contextPath];
}

export function applyLazyDirectoryChildren(
  model: FileTreeModel,
  attempt: FileTreeChildLoadAttempt,
  prefix: string,
  children: readonly string[],
  appliedPaths: Set<string>
): boolean {
  const operations: FileTreeBatchOperation[] = [];
  const nextChildren = new Set(children);
  for (const existing of appliedPaths) {
    if (!existing.startsWith(prefix)) continue;
    const remainder = existing.slice(prefix.length).replace(/\/$/, '');
    if (remainder === '' || remainder.includes('/')) continue;
    if (!nextChildren.has(existing)) {
      operations.push({ type: 'remove', path: existing, recursive: existing.endsWith('/') });
    }
  }
  for (const child of children) {
    if (!appliedPaths.has(child)) operations.push({ type: 'add', path: child });
  }
  if (!model.applyChildPatch(attempt, { operations })) return false;
  for (const operation of operations) {
    if (operation.type === 'add') {
      appliedPaths.add(operation.path);
      continue;
    }
    if (operation.type !== 'remove') continue;
    for (const applied of appliedPaths) {
      if (
        applied === operation.path ||
        (operation.recursive === true &&
          operation.path.endsWith('/') &&
          applied.startsWith(operation.path))
      ) {
        appliedPaths.delete(applied);
      }
    }
  }
  return true;
}

const DENSITY_OVERRIDE_STYLES = {
  '--trees-density-override': 0.8,
  '--trees-padding-inline-override': 8,
  '--trees-git-renamed-color-override': 'light-dark(#007aff, #007aff)',
} as CSSProperties;

interface DiffsHubFileTreeProps {
  className?: string;
  dragAndDrop?: FileTreeDragAndDropConfig;
  modelId?: string;
  lazyDirectories?: ReadonlySet<string>;
  pagedDirectories?: ReadonlySet<string>;
  onLoadDirectory?(path: string): Promise<readonly string[] | null>;
  onLoadMoreDirectory?(path: string): Promise<readonly string[] | null>;
  // Callback invoked with the underlying tree model once it's mounted, and
  // again with `null` on unmount. Lets parents drive imperative APIs like
  // search open/close without owning the model creation.
  onModelReady(model: FileTreeModel | null): void;
  onSelectItem(itemId: string): void;
  onSelectPaths?(paths: readonly string[]): void;
  renderContextMenu?(
    item: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[0],
    context: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[1],
    selectedPaths: readonly string[]
  ): ReactNode;
  renderRowActions?: FileTreeOptions['renderRowActions'];
  selectedPath?: string | null;
  selectedPaths?: readonly string[];
  showFolderGitStatus?: boolean;
  source: DiffsHubFileTreeSource;
}

export const DiffsHubFileTree = memo(function DiffsHubFileTree({
  className,
  dragAndDrop,
  modelId = 'gh-code-view-tree',
  lazyDirectories,
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
  showFolderGitStatus = false,
  source,
}: DiffsHubFileTreeProps) {
  const sourceRef = useRef(source);
  const dragAndDropRef = useRef(dragAndDrop);
  const renderContextMenuRef = useRef(renderContextMenu);
  const selectedPathRef = useRef(selectedPath);
  const onSelectPathsRef = useRef(onSelectPaths);
  const lazyDirectoriesRef = useRef(lazyDirectories);
  const pagedDirectoriesRef = useRef(pagedDirectories);
  const onLoadDirectoryRef = useRef(onLoadDirectory);
  const onLoadMoreDirectoryRef = useRef(onLoadMoreDirectory);
  const loadingMoreDirectoriesRef = useRef(new Set<string>());
  const syncingSelectionRef = useRef(false);
  const previousSourceRef = useRef(source);
  const [initialVisibleRowCount] = useState(getInitialBatchSize);
  sourceRef.current = source;
  dragAndDropRef.current = dragAndDrop;
  renderContextMenuRef.current = renderContextMenu;
  selectedPathRef.current = selectedPath;
  onSelectPathsRef.current = onSelectPaths;
  lazyDirectoriesRef.current = lazyDirectories;
  pagedDirectoriesRef.current = pagedDirectories;
  onLoadDirectoryRef.current = onLoadDirectory;
  onLoadMoreDirectoryRef.current = onLoadMoreDirectory;
  // `source.paths` aliases the streaming accumulator's live array, so it keeps
  // growing on later publishes. The FileTree model consumes its path list
  // exactly once via useFileTree's useState initializer; capture a bounded
  // snapshot here so the first model build uses only what `pathCount`
  // describes and so subsequent streaming re-renders don't re-slice the
  // ever-growing live array.
  const initialPathsRef = useRef<readonly string[] | null>(null);
  initialPathsRef.current ??= source.paths.slice(0, source.pathCount);
  const appliedPathsRef = useRef(new Set(initialPathsRef.current));
  const onSelectionChange = useStableCallback(
    (modelSelectedPaths: readonly FileTreePublicId[]) => {
      if (syncingSelectionRef.current || onSelectItem == null) return;
      const canonicalPaths = modelSelectedPaths.map(
        (path) => sourceRef.current.pathToItemId.get(path) ?? path
      );
      onSelectPathsRef.current?.(canonicalPaths);
      if (
        canonicalPaths.length === 0 &&
        onSelectPathsRef.current == null &&
        selectedPathRef.current != null
      ) {
        onSelectItem(selectedPathRef.current);
        return;
      }
      if (canonicalPaths.length !== 1) return;
      onSelectItem(canonicalPaths[0]);
    }
  );

  const stableCanDrag = useStableCallback((paths: readonly string[]) => {
    return dragAndDropRef.current?.canDrag?.(paths) ?? true;
  });
  const stableCanDrop = useStableCallback((event: FileTreeDropContext) => {
    const config = dragAndDropRef.current;
    return config?.canDrop?.(event) ?? true;
  });
  const stableOnDropComplete = useStableCallback((event: FileTreeDropResult) => {
    dragAndDropRef.current?.onDropComplete?.(event);
  });
  const stableOnDropError = useStableCallback((error: string, event: FileTreeDropContext) => {
    dragAndDropRef.current?.onDropError?.(error, event);
  });

  const handleClickCapture = useStableCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      selectedPathRef.current == null
    ) return;
    const row = event.nativeEvent
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.type === 'item'
      );
    const rowPath = row?.dataset.itemPath;
    if (rowPath == null) return;
    const canonicalPath = sourceRef.current.pathToItemId.get(rowPath) ?? rowPath;
    if (canonicalPath === selectedPathRef.current) onSelectItem(canonicalPath);
  });

  const stableRenderContextMenu = useStableCallback(
    (
      item: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[0],
      context: Parameters<NonNullable<FileTreeProps['renderContextMenu']>>[1]
    ) => {
      let modelSelectedPaths = model.getSelectedPaths();
      const contextSelection = resolveFileTreeContextSelection(modelSelectedPaths, item.path);
      if (contextSelection !== modelSelectedPaths) {
        syncingSelectionRef.current = true;
        for (const path of modelSelectedPaths) model.getItem(path)?.deselect();
        model.getItem(item.path)?.select();
        syncingSelectionRef.current = false;
        modelSelectedPaths = contextSelection;
        onSelectPathsRef.current?.([
          sourceRef.current.pathToItemId.get(item.path) ?? item.path,
        ]);
      }
      const canonicalPath = sourceRef.current.pathToItemId.get(item.path) ?? item.path;
      const canonicalItem =
        canonicalPath === item.path ? item : { ...item, path: canonicalPath };
      const canonicalSelectedPaths = modelSelectedPaths.map(
        (path) => sourceRef.current.pathToItemId.get(path) ?? path
      );
      return renderContextMenuRef.current?.(
        canonicalItem,
        context,
        canonicalSelectedPaths
      ) ?? null;
    }
  );

  const loadMoreForPaths = useStableCallback((paths: readonly string[]) => {
    for (const rowPath of [...paths].reverse()) {
      const normalized = rowPath.replace(/\/$/, '');
      const separator = normalized.lastIndexOf('/');
      const parent = separator < 0 ? '' : normalized.slice(0, separator);
      if (pagedDirectoriesRef.current?.has(parent) !== true) continue;
      if (loadingMoreDirectoriesRef.current.has(parent)) return;
      loadingMoreDirectoriesRef.current.add(parent);
      void onLoadMoreDirectoryRef.current?.(parent).finally(() => {
        loadingMoreDirectoriesRef.current.delete(parent);
      });
      return;
    }
  });

  const handleWheelCapture = useStableCallback((event: ReactWheelEvent<HTMLElement>) => {
    if (event.deltaY <= 0 || pagedDirectoriesRef.current == null) return;
    const scroller = event.nativeEvent
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.fileTreeVirtualizedScroll === 'true'
      );
    if (scroller == null || scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 12 * CODE_VIEW_FILE_TREE_ITEM_HEIGHT) {
      return;
    }
    const root = scroller.getRootNode();
    if (!(root instanceof ShadowRoot)) return;
    const paths = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-type="item"][data-item-path]:not([data-item-parked="true"])'
      ),
    ].slice(-8).flatMap((row) => (row.dataset.itemPath == null ? [] : [row.dataset.itemPath]));
    loadMoreForPaths(paths);
  });

  const stableRenderRowActions = useStableCallback(
    (
      context: Parameters<NonNullable<FileTreeOptions['renderRowActions']>>[0]
    ) => renderRowActions?.(context) ?? null
  );

  const { model } = useFileTree({
    ...(lazyDirectories == null
      ? showFolderGitStatus
        ? REPOSITORY_FILE_TREE_OPTIONS
        : BASE_FILE_TREE_OPTIONS
      : LAZY_REPOSITORY_FILE_TREE_OPTIONS),
    id: modelId,
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
    sort: PRESERVE_INPUT_ORDER_SORT,
    onSelectionChange,
    renderRowActions: stableRenderRowActions,
    itemHeight: CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
    initialVisibleRowCount,
    initialUnloadedDirectoryPaths: lazyDirectories == null ? undefined : [...lazyDirectories],
  });

  useEffect(() => {
    if (lazyDirectories == null) return;
    const nextPaths = new Set(source.paths.slice(0, source.pathCount));
    const operations = filterAlreadyAppliedLazyOperations(
      buildLazyPathReconciliationOperations(appliedPathsRef.current, nextPaths),
      (path) => model.getItem(path) != null
    );
    if (operations.length > 0) model.batch(operations);
    model.setGitStatus(source.gitStatus);
    appliedPathsRef.current = nextPaths;
    for (const path of lazyDirectories) {
      if (model.getItem(path)?.isDirectory() && model.getDirectoryLoadState(path) === 'loaded') {
        model.markDirectoryUnloaded(path);
      }
    }
  }, [lazyDirectories, model, source]);

  useEffect(() => {
    if (lazyDirectories == null || onLoadDirectory == null) return;
    const expanded = new Set<string>();
    const load = (path: string) => {
      const attempt = model.beginChildLoad(path);
      void onLoadDirectoryRef.current?.(path.replace(/\/$/, ''))
        .then((children) => {
          if (children == null) {
            model.failChildLoad(attempt, 'Directory loading was canceled');
            return;
          }
          if (!applyLazyDirectoryChildren(model, attempt, path, children, appliedPathsRef.current)) {
            return;
          }
          for (const child of children) {
            if (
              child.endsWith('/') &&
              lazyDirectoriesRef.current?.has(child) === true &&
              model.getItem(child)?.isDirectory() &&
              model.getDirectoryLoadState(child) === 'loaded'
            ) {
              model.markDirectoryUnloaded(child);
            }
          }
          model.completeChildLoad(attempt);
        })
        .catch((reason: unknown) => {
          model.failChildLoad(attempt, reason instanceof Error ? reason.message : String(reason));
        });
    };
    return model.subscribe(() => {
      const nextExpanded = new Set<string>();
      for (const path of appliedPathsRef.current) {
        if (!path.endsWith('/')) continue;
        const item = model.getItem(path);
        if (item == null || !item.isDirectory()) continue;
        if (!(item as FileTreeDirectoryHandle).isExpanded()) continue;
        nextExpanded.add(path);
        const wasExpanded = expanded.has(path);
        expanded.add(path);
        if (!wasExpanded && model.getDirectoryLoadState(path) !== 'loading') load(path);
      }
      for (const path of expanded) {
        if (!nextExpanded.has(path)) expanded.delete(path);
      }
    });
  }, [model, onLoadDirectory]);

  useEffect(() => {
    if (lazyDirectories != null) return;
    const previousSource = previousSourceRef.current;
    if (previousSource === source) {
      return;
    }

    previousSourceRef.current = source;
    // The streaming patch loader links each tree-source snapshot to the prior
    // one through `previousSource`. When the link matches what this component
    // last applied, the new paths array is guaranteed to extend the previous
    // one, so we apply the delta as add() operations instead of asking the
    // model to throw itself away and rebuild against the full path list. This
    // turns tree publishes from O(N) each (where N is the total accumulated
    // path count) into O(delta), which keeps the Diff Stats counter fast as
    // more files stream in.
    //
    // Both snapshots alias the live accumulator's paths array, so we read the
    // delta bounds from each snapshot's captured `pathCount` instead of the
    // shared array's current length.
    if (
      source.previousSource != null &&
      source.previousSource === previousSource
    ) {
      const previousPathCount = previousSource.pathCount;
      if (source.pathCount > previousPathCount) {
        const operations: FileTreeBatchOperation[] = [];
        for (let index = previousPathCount; index < source.pathCount; index++) {
          operations.push({ type: 'add', path: source.paths[index] });
        }
        if (operations.length > 0) {
          model.batch(operations);
        }
      }
      if (source.gitStatusPatch != null) {
        model.applyGitStatusPatch(source.gitStatusPatch);
      }
    } else {
      model.resetPaths(source.paths.slice(0, source.pathCount));
      model.setGitStatus(source.gitStatus);
    }
  }, [model, source]);

  useEffect(() => {
    onModelReady(model);
    return () => onModelReady(null);
  }, [model, onModelReady]);

  useEffect(() => {
    const canonicalSelectedPaths =
      selectedPaths ?? (selectedPath == null ? [] : [selectedPath]);
    const modelPaths = canonicalSelectedPaths.map(
      (path) => source.itemIdToPath?.get(path) ?? path
    );
    const modelPathSet = new Set(modelPaths);
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (!modelPathSet.has(path)) model.getItem(path)?.deselect();
    }
    for (const modelPath of modelPaths) model.getItem(modelPath)?.select();
    const modelPath =
      selectedPath == null
        ? (modelPaths.at(-1) ?? null)
        : (source.itemIdToPath?.get(selectedPath) ?? selectedPath);
    if (modelPath == null) {
      syncingSelectionRef.current = false;
      return;
    }
    const segments = modelPath.split('/');
    let directoryPath = '';
    for (const segment of segments.slice(0, -1)) {
      directoryPath += `${segment}/`;
      const item = model.getItem(directoryPath);
      if (item?.isDirectory()) (item as FileTreeDirectoryHandle).expand();
    }
    syncingSelectionRef.current = false;
    queueMicrotask(() => model.scrollToPath(modelPath, { focus: false, offset: 'nearest' }));
  }, [model, selectedPath, selectedPaths, source]);

  return (
    <ThemedFileTree
      className={cn('h-full min-h-0 overflow-auto overscroll-contain md:ml-3', className)}
      model={model}
      onClickCapture={handleClickCapture}
      onWheelCapture={handleWheelCapture}
      reconcileForegroundFromChrome
      renderContextMenu={renderContextMenu == null ? undefined : stableRenderContextMenu}
      style={DENSITY_OVERRIDE_STYLES}
    />
  );
});
