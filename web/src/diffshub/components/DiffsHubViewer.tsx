// Modified from the pinned DiffsHub donor: Gitna adds local file and hunk
// mutation actions to the donor CodeView header metadata slot and can disable
// the donor comment affordance when mounted in the Source Control-only shell.
import {
  areSelectionsEqual,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffIndicators,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffContentsLoader,
  type LineAnnotation,
  type SelectedLineRange,
  type ThemeTypes,
} from '@pierre/diffs';
import { Editor, type EditorOptions } from '@pierre/diffs/edit';
import { EditProvider, type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { IconCheck, IconChevronSm } from '@pierre/icons';
import { memo, type ComponentProps, type RefObject, useMemo, useRef, useState } from 'react';

import { Button } from './Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { DraftAnnotation } from './DraftAnnotation';
import { ExampleAnnotation } from './ExampleAnnotation';
import { ThemedCodeView } from './ThemedCodeView';
import { useChromeThemeProps } from './useChromeThemeProps';
import { ImageAnnotation } from '../gitna/ImageAnnotation';
import type { AvatarName } from '@/lib/annotation';
import { buildAnnotationThemeStyle } from '@/lib/annotationThemeStyle';
import { classifyCommentLineType } from '@/lib/classifyCommentLineType';
import { cn } from '@/lib/cn';
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from '@/lib/constants';
import { isDiffItem } from '@/lib/isDiffItem';
import { isDraftAnnotation } from '@/lib/isDraftAnnotation';
import { isDraftMetadata } from '@/lib/isDraftMetadata';
import { isSavedAnnotation } from '@/lib/isSavedAnnotation';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import type {
  CommentMetadata,
  DiffsHubDeletedCommentEvent,
  DiffsHubSavedCommentEvent,
} from '@/lib/types';
import type { MutateRequest } from '../../lib/api';
import { splitHunkPatches } from '../../lib/hunk-patches';
import type { ChangeKind, ChangeScope, FileDiff } from '../../lib/types';

export type GitnaFileAction = 'stage' | 'unstage' | 'discard' | 'delete';

export interface GitnaEditorActions {
  changeScopes(path: string): readonly ChangeScope[];
  dirtyPaths: ReadonlySet<string>;
  recentlySavedPath: string | null;
  saving: boolean;
  onChange(path: string, file: FileContents): void;
  onOpenChange(scope: ChangeScope, path: string): void;
  onSave(path: string): void;
}

export interface GitnaViewerActions {
  canOpenFile(path: string): boolean;
  kindForPath(path: string): ChangeKind | undefined;
  loadDiff(path: string): Promise<FileDiff>;
  onFileAction(action: GitnaFileAction, path: string, kind: ChangeKind): void;
  onOpenFile(path: string): void;
  onPatch(request: MutateRequest): Promise<void>;
  onError(error: string): void;
  scope: 'staged' | 'unstaged';
}

function getNextItemVersion(item: CodeViewItem<CommentMetadata>): number {
  return typeof item.version === 'number' ? item.version + 1 : 1;
}

function updateViewerDiffItem(
  viewer: CodeViewHandle<CommentMetadata>,
  itemId: string,
  updateItem: (item: CodeViewDiffItem<CommentMetadata>) => boolean
): CodeViewDiffItem<CommentMetadata> | undefined {
  const item = viewer.getItem(itemId);
  if (item == null || !isDiffItem(item)) {
    return undefined;
  }

  if (!updateItem(item)) {
    return undefined;
  }

  item.version = getNextItemVersion(item);
  return viewer.updateItem(item) ? item : undefined;
}

interface ActiveDraftComment {
  itemId: string;
  key: string;
}

interface DiffsHubViewerProps {
  className?: string;
  commentsEnabled?: boolean;
  diffStyle: 'split' | 'unified';
  onCommentDeleted(comment: DiffsHubDeletedCommentEvent): void;
  onCommentSaved(comment: DiffsHubSavedCommentEvent): void;
  overflow: 'wrap' | 'scroll';
  showBackgrounds: boolean;
  diffIndicators: DiffIndicators;
  lineNumbers: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  themeType: ThemeTypes;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
  initialItems: CodeViewItem<CommentMetadata>[];
  loadDiffFiles?: FileDiffContentsLoader;
  onLineLinkChange(selection: CodeViewLineSelection | null): void;
  onViewerReady(): void;
  gitnaActions?: GitnaViewerActions;
  gitnaEditorActions?: GitnaEditorActions;
}

export const DiffsHubViewer = memo(function DiffsHubViewer({
  className,
  commentsEnabled = true,
  diffStyle,
  onCommentDeleted,
  onCommentSaved,
  overflow,
  showBackgrounds,
  diffIndicators,
  lineNumbers,
  scrollRef,
  themeType,
  viewerRef,
  initialItems,
  loadDiffFiles,
  onLineLinkChange,
  onViewerReady,
  gitnaActions,
  gitnaEditorActions,
}: DiffsHubViewerProps) {
  const nextCommentKeyRef = useRef(0);
  const activeDraftRef = useRef<ActiveDraftComment | null>(null);
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null);
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  // Preserve the previous `undefined`-means-not-resolved contract that
  // buildAnnotationThemeStyle and the className fallbacks depend on.
  const themeChromeStyle =
    Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined;
  const annotationThemeStyle = useMemo(
    () => buildAnnotationThemeStyle(themeChromeStyle),
    [themeChromeStyle]
  );
  const handleSetSelection = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      setSelectedLines(selection);
    }
  );

  const handleToggleCommentSelection = useStableCallback(
    (selection: CodeViewLineSelection) => {
      setSelectedLines((prev) =>
        prev?.id === selection.id &&
        areSelectionsEqual(prev.range, selection.range)
          ? null
          : selection
      );
    }
  );

  const handleLineSelectionEnd = useStableCallback(
    (range: SelectedLineRange | null, item: CodeViewItem<CommentMetadata>) => {
      if (range == null || item.type !== 'diff') {
        onLineLinkChange(null);
      } else {
        onLineLinkChange({ id: item.id, range });
      }
    }
  );

  const handleViewerRef = useStableCallback(
    (viewer: CodeViewHandle<CommentMetadata> | null) => {
      viewerRef.current = viewer;
      if (viewer != null) {
        onViewerReady();
      }
    }
  );

  const handleCreateDraftComment = useStableCallback(
    (range: SelectedLineRange, itemId: string) => {
      const side = range.endSide ?? range.side;
      if (side == null) {
        return;
      }

      const lineNumber = range.end;
      const commentKey = `draft-${nextCommentKeyRef.current++}`;
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }

      const draftAnnotation: DiffLineAnnotation<CommentMetadata> = {
        side,
        lineNumber,
        metadata: {
          kind: 'draft',
          key: commentKey,
          message: '',
          range,
        },
      };

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft != null && activeDraft.itemId !== itemId) {
        updateViewerDiffItem(viewer, activeDraft.itemId, (item) => {
          if (item.annotations == null) {
            return false;
          }

          const nextAnnotations = item.annotations.filter(
            (annotation) => annotation.metadata.key !== activeDraft.key
          );
          if (nextAnnotations.length === item.annotations.length) {
            return false;
          }

          item.annotations = nextAnnotations;
          return true;
        });
      }

      const updatedItem = updateViewerDiffItem(viewer, itemId, (item) => {
        const nonDraftAnnotations = (item.annotations ?? []).filter(
          (annotation) => !isDraftMetadata(annotation.metadata)
        );
        item.annotations = [...nonDraftAnnotations, draftAnnotation];
        return true;
      });

      if (updatedItem != null) {
        activeDraftRef.current = { itemId, key: commentKey };
      }
    }
  );

  const handleRemoveComment = useStableCallback(
    (itemId: string, key: string) => {
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      const removedAnnotation =
        item != null && isDiffItem(item)
          ? item.annotations?.find(
              (annotation) => annotation.metadata.key === key
            )
          : undefined;

      updateViewerDiffItem(viewer, itemId, (item) => {
        if (item.annotations == null) {
          return false;
        }

        const nextAnnotations = item.annotations.filter(
          (annotation) => annotation.metadata.key !== key
        );

        if (nextAnnotations.length === item.annotations.length) {
          return false;
        }

        item.annotations = nextAnnotations;
        return true;
      });

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft?.itemId === itemId && activeDraft.key === key) {
        activeDraftRef.current = null;
      }

      setSelectedLines(null);
      onLineLinkChange(null);
      if (removedAnnotation != null && isSavedAnnotation(removedAnnotation)) {
        onCommentDeleted({ itemId, key });
      }
    }
  );

  const handleSaveDraftComment = useStableCallback(
    (itemId: string, key: string, message: string, author: AvatarName) => {
      const trimmedMessage = message.trim();
      const { current: viewer } = viewerRef;
      if (trimmedMessage.length === 0 || viewer == null) {
        return;
      }

      const item = viewer.getItem(itemId);
      if (item == null || !isDiffItem(item)) {
        return;
      }

      const draftAnnotation = item?.annotations?.find(
        (annotation) => annotation.metadata.key === key
      );
      if (draftAnnotation == null || !isDraftAnnotation(draftAnnotation)) {
        return;
      }

      const updatedItem = updateViewerDiffItem(viewer, itemId, (item) => {
        if (item.annotations == null) {
          return false;
        }

        const nextAnnotations: DiffLineAnnotation<CommentMetadata>[] =
          item.annotations.map((annotation) => {
            if (
              annotation.metadata.key !== key ||
              !isDraftAnnotation(annotation)
            ) {
              return annotation;
            }

            return {
              ...annotation,
              metadata: {
                kind: 'saved',
                key,
                author,
                message: trimmedMessage,
                range: annotation.metadata.range,
              },
            };
          });

        let didChange = false;
        for (let index = 0; index < nextAnnotations.length; index++) {
          if (nextAnnotations[index] !== item.annotations[index]) {
            didChange = true;
            break;
          }
        }

        if (!didChange) {
          return false;
        }

        item.annotations = nextAnnotations;
        return true;
      });

      if (updatedItem == null) {
        return;
      }

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft?.itemId === itemId && activeDraft.key === key) {
        activeDraftRef.current = null;
      }

      setSelectedLines(null);
      onLineLinkChange(null);
      onCommentSaved({
        author,
        itemId,
        key,
        lineNumber: draftAnnotation.lineNumber,
        lineType: classifyCommentLineType(
          item.fileDiff,
          draftAnnotation.side,
          draftAnnotation.lineNumber
        ),
        message: trimmedMessage,
        range: draftAnnotation.metadata.range,
        side: draftAnnotation.side,
      });
    }
  );

  const handleToggleItemCollapsed = useStableCallback((itemId: string) => {
    const { current: viewerHandle } = viewerRef;
    const viewer = viewerHandle?.getInstance();
    const item = viewerHandle?.getItem(itemId);
    if (viewerHandle == null || viewer == null || item == null) {
      return;
    }

    // NOTE(amadeus): If the top of the item is before the scrollTop, then
    // we'll want to apply a scroll fix on the next render to ensure we
    // keep the collapsed file in view and anchored.
    const itemTop = viewer.getTopForItem(itemId);
    item.collapsed = item.collapsed !== true;
    item.version = getNextItemVersion(item);
    if (!viewerHandle.updateItem(item)) {
      return;
    }

    if (itemTop != null && itemTop < viewer.getScrollTop()) {
      viewer.scrollTo({
        type: 'item',
        id: item.id,
        align: 'start',
      });
    }
  });

  const renderCommentAnnotation = useStableCallback(
    (
      annotation:
        | DiffLineAnnotation<CommentMetadata>
        | LineAnnotation<CommentMetadata>,
      item: CodeViewItem<CommentMetadata>
    ) => {
      if (annotation.metadata.kind === 'image' || !commentsEnabled || !('side' in annotation) || item.type !== 'diff') {
        return null;
      }

      if (isDraftAnnotation(annotation)) {
        return (
          <DraftAnnotation
            annotation={annotation}
            itemId={item.id}
            onCancel={handleRemoveComment}
            onSave={handleSaveDraftComment}
          />
        );
      }

      if (!isSavedAnnotation(annotation)) {
        return null;
      }

      return (
        <ExampleAnnotation
          annotation={annotation}
          itemId={item.id}
          onDelete={handleRemoveComment}
          onToggleSelection={handleToggleCommentSelection}
        />
      );
    }
  );

  const renderBody = useStableCallback((item: CodeViewItem<CommentMetadata>) => {
    const images = item.annotations?.flatMap((annotation) =>
      annotation.metadata.kind === 'image'
        ? [{ metadata: annotation.metadata, side: 'side' in annotation ? annotation.side : undefined }]
        : []
    );
    if (images == null || images.length === 0) {
      return null;
    }
    const split = images.length > 1;
    const framed = item.type === 'diff';
    return (
      <div className={split ? 'grid grid-cols-2' : undefined}>
        {images.map(({ metadata, side }) => (
          <div
            key={metadata.key}
            className={cn(
              split && side === 'deletions' && 'border-r border-[var(--diffs-bg-separator)]',
              split && side === 'additions' && 'border-l border-[var(--diffs-bg-separator)]'
            )}
          >
            <ImageAnnotation fill={framed} metadata={metadata} />
          </div>
        ))}
      </div>
    );
  });

  const renderHeaderMetadata = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type === 'file' && gitnaEditorActions != null) {
        return <WorktreeHeaderActions actions={gitnaEditorActions} path={item.file.name} />;
      }
      if (item.type !== 'diff' || gitnaActions == null) return null;
      return <GitnaHeaderActions actions={gitnaActions} item={item} />;
    }
  );

  const renderHeaderPrefix = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type !== 'diff') {
        return null;
      }

      return (
        <CollapseDiffButton
          disabled={
            !item.annotations?.some((annotation) => annotation.metadata.kind === 'image') &&
            item.fileDiff.splitLineCount === 0 &&
            item.fileDiff.unifiedLineCount === 0
          }
          collapsed={item.collapsed}
          onToggle={() => handleToggleItemCollapsed(item.id)}
        />
      );
    }
  );

  // NOTE(amadeus): For some insane reason, the react compiler did not know how
  // to properly memoize this, so we pulled it into a `useMemo` for safety...
  const options: CodeViewOptions<CommentMetadata> = useMemo(
    () =>
      ({
        // Use this to validate itemMetrics when changing layout with unsafeCSS.
        // __devOnlyValidateItemHeights: true,
        layout: CODE_VIEW_LAYOUT,
        themeType,
        diffStyle,
        diffIndicators,
        overflow,
        loadDiffFiles,
        disableBackground: !showBackgrounds,
        disableLineNumbers: !lineNumbers,
        lineHoverHighlight: 'number',
        // hunkSeparators: 'line-info-basic',
        enableLineSelection: commentsEnabled,
        enableGutterUtility: commentsEnabled,
        stickyHeaders: true,
        unsafeCSS: CODE_VIEW_CUSTOM_CSS,
        // FIXME(amadeus): Move all `onX` methods onto the react component maybe?
        onGutterUtilityClick: commentsEnabled
          ? (range, context) => {
              if (context.item.type !== 'diff') {
                return;
              }
              handleCreateDraftComment(range, context.item.id);
            }
          : undefined,
        onLineSelectionEnd: commentsEnabled
          ? (range, context) => handleLineSelectionEnd(range, context.item)
          : undefined,
      }) satisfies CodeViewOptions<CommentMetadata>,
    [
      commentsEnabled,
      diffIndicators,
      diffStyle,
      handleCreateDraftComment,
      handleLineSelectionEnd,
      lineNumbers,
      loadDiffFiles,
      overflow,
      showBackgrounds,
      themeType,
    ]
  );
  const handleItemEditChange = useStableCallback(
    (item: CodeViewItem<CommentMetadata>, file: FileContents) => {
      gitnaEditorActions?.onChange(item.id, file);
    }
  );

  return (
    <EditProvider<CommentMetadata> createEditor={createWorktreeEditor}>
      <ThemedCodeView<CommentMetadata>
      ref={handleViewerRef}
      containerRef={scrollRef}
      initialItems={initialItems}
      className={cn(
        className,
        'cv-scrollbar relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain border-b border-border w-full [contain:strict] [overflow-anchor:none] [will-change:scroll-position] md:border-b-0 [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style] [&_diffs-container]:shadow-[0_-1px_0_var(--diffshub-diff-separator,var(--color-border-opaque)),0_1px_0_var(--diffshub-diff-separator,var(--color-border-opaque))]'
      )}
      options={options}
      editorOptions={WORKTREE_EDITOR_OPTIONS}
      onItemEditChange={gitnaEditorActions == null ? undefined : handleItemEditChange}
      style={annotationThemeStyle}
      selectedLines={commentsEnabled ? selectedLines : null}
      onSelectedLinesChange={handleSetSelection}
      renderAnnotation={renderCommentAnnotation}
      renderBody={renderBody}
      renderHeaderMetadata={renderHeaderMetadata}
      renderHeaderPrefix={renderHeaderPrefix}
      />
    </EditProvider>
  );
});

const WORKTREE_EDITOR_OPTIONS = { persistState: true } satisfies EditorOptions<CommentMetadata>;

function createWorktreeEditor(options: EditorOptions<CommentMetadata>) {
  return new Editor<CommentMetadata>(options);
}

function FileHeaderAction({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn(
        'h-6 rounded px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

function WorktreeHeaderActions({
  actions,
  path,
}: {
  actions: GitnaEditorActions;
  path: string;
}) {
  const dirty = actions.dirtyPaths.has(path);
  const recentlySaved = actions.recentlySavedPath === path;
  const scopes = actions.changeScopes(path);
  const openChange = (scope: ChangeScope) => actions.onOpenChange(scope, path);
  return (
    <span className="inline-flex items-center gap-0.5">
      {scopes.length === 1 && (
        <FileHeaderAction
          type="button"
          aria-label={`${scopes[0] === 'staged' ? 'View staged changes' : 'View changes'} for ${path}`}
          onClick={() => openChange(scopes[0]!)}
        >
          {scopes[0] === 'staged' ? 'View Staged' : 'View Changes'}
        </FileHeaderAction>
      )}
      {scopes.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FileHeaderAction type="button" aria-label={`Choose changes to view for ${path}`}>
              View Changes…
            </FileHeaderAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openChange('unstaged')}>
              View Unstaged Changes
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openChange('staged')}>
              View Staged Changes
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <FileHeaderAction
        type="button"
        aria-hidden={!dirty && !recentlySaved}
        className={cn(!dirty && !recentlySaved && 'invisible')}
        disabled={!dirty || actions.saving}
        tabIndex={dirty ? 0 : -1}
        title={dirty ? `Save ${path}` : undefined}
        onClick={() => actions.onSave(path)}
      >
        {dirty ? (
          actions.saving ? (
            'Saving…'
          ) : (
            'Save'
          )
        ) : recentlySaved ? (
          <span className="flex items-center gap-1" role="status">
            <IconCheck className="size-3" />
            Saved
          </span>
        ) : (
          'Save'
        )}
      </FileHeaderAction>
    </span>
  );
}

function inferGitnaKind(
  item: CodeViewDiffItem<CommentMetadata>
): ChangeKind {
  switch (item.fileDiff.type) {
    case 'new':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'rename-pure':
    case 'rename-changed':
      return 'renamed';
    default:
      return 'modified';
  }
}

function GitnaHeaderActions({
  actions,
  item,
}: {
  actions: GitnaViewerActions;
  item: CodeViewDiffItem<CommentMetadata>;
}) {
  const [hunks, setHunks] = useState<ReturnType<typeof splitHunkPatches> | null>(
    null
  );
  const [patchId, setPatchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const path = item.fileDiff.name;
  const kind = actions.kindForPath(path) ?? inferGitnaKind(item);
  const primary = actions.scope === 'staged' ? 'unstage' : 'stage';
  const primaryLabel = actions.scope === 'staged' ? 'Unstage' : 'Stage';
  const destructive = kind === 'untracked' ? 'delete' : 'discard';
  const destructiveLabel = kind === 'untracked' ? 'Delete' : 'Discard';

  const loadHunks = async () => {
    setLoading(true);
    try {
      const diff = await actions.loadDiff(path);
      const next = splitHunkPatches(diff.patch ?? '');
      setPatchId(diff.patchId ?? null);
      setHunks(next);
    } catch (error) {
      actions.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      {actions.canOpenFile(path) && (
        <FileHeaderAction
          type="button"
          aria-label={`Open ${path} in Repository`}
          onClick={() => actions.onOpenFile(path)}
        >
          Open File
        </FileHeaderAction>
      )}
      <FileHeaderAction
        type="button"
        aria-label={`${primaryLabel} file ${path}`}
        onClick={() => actions.onFileAction(primary, path, kind)}
      >
        {primaryLabel}
      </FileHeaderAction>
      {actions.scope === 'unstaged' && (
        <FileHeaderAction
          type="button"
          aria-label={`${destructiveLabel} file ${path}`}
          onClick={() => actions.onFileAction(destructive, path, kind)}
        >
          {destructiveLabel}
        </FileHeaderAction>
      )}
      {item.fileDiff.hunks.length > 0 && kind === 'modified' && hunks == null && (
        <FileHeaderAction
          type="button"
          disabled={loading}
          aria-label={`Show hunk actions for ${path}`}
          onClick={() => void loadHunks()}
        >
          {loading ? 'Loading…' : 'Hunks'}
        </FileHeaderAction>
      )}
      {hunks?.map((hunk, index) => {
        const verb = actions.scope === 'staged' ? 'Unstage' : 'Stage';
        return (
          <FileHeaderAction
            key={hunk.range}
            type="button"
            disabled={patchId == null}
            aria-label={`${verb} hunk ${index + 1} in ${path}`}
            title={hunk.range}
            onClick={() => {
              if (patchId == null) return;
              void actions
                .onPatch({
                  op: 'patch',
                  patch: hunk.patch,
                  patchId,
                  scope: actions.scope,
                  path,
                  reverse: actions.scope === 'staged',
                })
                .catch((error: unknown) =>
                  actions.onError(
                    error instanceof Error ? error.message : String(error)
                  )
                );
            }}
          >
            {verb} {index + 1}
          </FileHeaderAction>
        );
      })}
    </span>
  );
}

interface CollapseDiffButtonProps {
  disabled?: boolean;
  collapsed?: boolean;
  onToggle(): void;
}

function CollapseDiffButton({
  disabled = false,
  collapsed = false,
  onToggle,
}: CollapseDiffButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={!disabled && !collapsed}
      aria-hidden={disabled}
      aria-label={
        disabled ? undefined : collapsed ? 'Expand diff' : 'Collapse diff'
      }
      className="text-muted-foreground hover:bg-muted hover:text-foreground ml-[-8px] inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition disabled:pointer-events-none disabled:opacity-50"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <IconChevronSm
        aria-hidden="true"
        className={cn(
          'size-4 transition-transform',
          (disabled || collapsed) && '-rotate-90'
        )}
      />
    </button>
  );
}
