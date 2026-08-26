'use client';

import { useStableCallback } from '@pierre/diffs/react';
import type {
  FileTreeBatchOperation,
  FileTree as FileTreeModel,
  FileTreeOptions,
} from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import { type CSSProperties, memo, useEffect, useRef, useState } from 'react';

// Modified from the pinned DiffsHub donor: the monorepo-private public-id
// import is replaced by its package-level string contract for standalone Vite.
type FileTreePublicId = string;
import { ThemedFileTree } from './ThemedFileTree';
import {
  BASE_FILE_TREE_OPTIONS,
  CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
  getInitialBatchSize,
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

// Layout-only overrides. Colors flow through from the resolved Shiki theme
// (via themeToTreeStyles) so the sidebar matches the diff theme, but the
// density and padding stay tuned for the diffshub layout regardless of
// which theme the user picks. `--trees-git-renamed-color-override` is kept
// because most Shiki themes don't define a "renamed" decoration color.
const DENSITY_OVERRIDE_STYLES = {
  '--trees-density-override': 0.8,
  '--trees-padding-inline-override': 8,
  '--trees-git-renamed-color-override': 'light-dark(#007aff, #007aff)',
} as CSSProperties;

interface DiffsHubFileTreeProps {
  className?: string;
  modelId?: string;
  // Callback invoked with the underlying tree model once it's mounted, and
  // again with `null` on unmount. Lets parents drive imperative APIs like
  // search open/close without owning the model creation.
  onModelReady(model: FileTreeModel | null): void;
  onSelectItem(itemId: string): void;
  renderRowActions?: FileTreeOptions['renderRowActions'];
  selectedPath?: string | null;
  showFolderGitStatus?: boolean;
  source: DiffsHubFileTreeSource;
}

export const DiffsHubFileTree = memo(function DiffsHubFileTree({
  className,
  modelId = 'gh-code-view-tree',
  onModelReady,
  onSelectItem,
  renderRowActions,
  selectedPath,
  showFolderGitStatus = false,
  source,
}: DiffsHubFileTreeProps) {
  const sourceRef = useRef(source);
  const previousSourceRef = useRef(source);
  const [initialVisibleRowCount] = useState(getInitialBatchSize);
  sourceRef.current = source;
  // `source.paths` aliases the streaming accumulator's live array, so it keeps
  // growing on later publishes. The FileTree model consumes its path list
  // exactly once via useFileTree's useState initializer; capture a bounded
  // snapshot here so the first model build uses only what `pathCount`
  // describes and so subsequent streaming re-renders don't re-slice the
  // ever-growing live array.
  const initialPathsRef = useRef<readonly string[] | null>(null);
  initialPathsRef.current ??= source.paths.slice(0, source.pathCount);
  const onSelectionChange = useStableCallback(
    (selectedPaths: readonly FileTreePublicId[]) => {
      if (selectedPaths.length !== 1 || onSelectItem == null) {
        return;
      }
      const [path] = selectedPaths;
      const itemId = sourceRef.current.pathToItemId.get(path);
      if (itemId != null) {
        onSelectItem(itemId);
      }
    }
  );

  const stableRenderRowActions = useStableCallback(
    (
      context: Parameters<NonNullable<FileTreeOptions['renderRowActions']>>[0]
    ) => renderRowActions?.(context) ?? null
  );

  const { model } = useFileTree({
    ...(showFolderGitStatus ? REPOSITORY_FILE_TREE_OPTIONS : BASE_FILE_TREE_OPTIONS),
    id: modelId,
    gitStatus: source.gitStatus,
    paths: initialPathsRef.current,
    sort: PRESERVE_INPUT_ORDER_SORT,
    onSelectionChange,
    renderRowActions: stableRenderRowActions,
    itemHeight: CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
    initialVisibleRowCount,
  });

  useEffect(() => {
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
    const modelPath =
      selectedPath == null
        ? null
        : (source.itemIdToPath?.get(selectedPath) ?? selectedPath);
    for (const path of model.getSelectedPaths()) {
      if (path !== modelPath) model.getItem(path)?.deselect();
    }
    if (modelPath != null) model.getItem(modelPath)?.select();
  }, [model, selectedPath, source]);

  return (
    <ThemedFileTree
      className={cn('h-full min-h-0 overflow-auto overscroll-contain md:ml-3', className)}
      model={model}
      reconcileForegroundFromChrome
      style={DENSITY_OVERRIDE_STYLES}
    />
  );
});
