// Modified by Gitna: declare callbacks as receiver-independent function properties.
// Modified from the pinned DiffsHub donor: Gitna adds local file and hunk
// mutation actions to the donor CodeView header metadata slot, and the donor
// comment affordance creates persistent Gitna conversations instead of
// in-memory demo comments.
import {
  areObjectsEqual,
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffIndicators,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffContentsLoader,
  type LineAnnotation,
  type SelectedLineRange,
  type ThemeTypes,
} from '@pierre/diffs';
import {
  Editor,
  type EditorChangeEvent,
  type EditorOptions,
  type EditorViewState,
  type EditorType,
} from '@pierre/diffs/edit';
import { EditProvider, type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { IconCheck, IconChevronSm, IconDiffSplit, IconEye } from '@pierre/icons';
import {
  memo,
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from './Button';
import { useLoadingIndicator } from '../lib/loading';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { DraftAnnotation } from './DraftAnnotation';
import { ThemedCodeView } from './ThemedCodeView';
import { useChromeThemeProps } from './useChromeThemeProps';
import { ImageAnnotation } from '../gitna/ImageAnnotation';
import { buildAnnotationThemeStyle } from '@/lib/annotationThemeStyle';
import { cn } from '@/lib/cn';
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from '@/lib/constants';
import { shownCode } from '@/lib/draftLocation';
import { isDraftMetadata } from '@/lib/isDraftMetadata';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import type { CommentMetadata, DraftCommentMetadata } from '@/lib/types';
import type { MutateRequest } from '../../lib/api';
import { splitHunkPatches } from '../../lib/hunk-patches';
import type { ChangeKind, ChangeScope, FileDiff, ContentSearchMatch } from '../../lib/types';
import { installSearchHighlights, type ActiveSearchMatch } from '../gitna/searchHighlights';
import { ConversationThread } from '../gitna/ConversationThread';
import {
  captureLines,
  type ConversationAnchor,
  type ConversationSide,
  type ConversationSurface,
  type ConversationsModel,
} from '../../lib/conversations';

export type GitnaFileAction = 'stage' | 'unstage' | 'discard' | 'delete';

export interface GitnaEditorActions {
  changeScopes(path: string): readonly ChangeScope[];
  dirtyPaths: ReadonlySet<string>;
  recentlySavedPath: string | null;
  saving: boolean;
  disabledReason?: string | null;
  onChange: (path: string, file: FileContents, viewState: EditorViewState) => void;
  onOpenChange: (scope: ChangeScope, path: string) => void;
  onSave: (path: string) => void;
  previewLabel?: 'Markdown' | 'SVG';
  previewMode?: 'editor' | 'preview' | 'split';
  onPreviewModeChange?: (mode: 'editor' | 'preview' | 'split') => void;
}

export interface GitnaComparisonActions {
  leftDirty: boolean;
  leftPath: string;
  rightDirty: boolean;
  rightPath: string;
  onSwap: () => void;
}

export interface GitnaOpenFileAction {
  ariaLabel(path: string): string;
  canOpenFile(path: string): boolean;
  onOpenFile: (path: string) => void;
}

export interface GitnaConversationActions {
  visible: boolean;
  model: ConversationsModel;
  surface: ConversationSurface;
}

type ConversationViewItem = CodeViewItem<CommentMetadata>;
type ConversationAnnotation = LineAnnotation<CommentMetadata> | DiffLineAnnotation<CommentMetadata>;

function sidePath(item: ConversationViewItem, side: ConversationSide): string {
  if (item.type === 'file') return item.file.name;
  return side === 'deletions' ? (item.fileDiff.prevName ?? item.fileDiff.name) : item.fileDiff.name;
}

// A conversation belongs to content, not to a view: it appears on whichever
// side of whichever view shows the content it was started on.
function conversationAnnotations(
  item: ConversationViewItem,
  { model, surface }: GitnaConversationActions
): ConversationAnnotation[] {
  const sides: ConversationSide[] = item.type === 'file' ? ['additions'] : ['deletions', 'additions'];
  return sides.flatMap((side) => {
    const content = surface[side];
    if (content == null) return [];
    const same = side === 'additions' && surface.same != null ? model.get(surface.same, sidePath(item, side)) : [];
    return [...model.get(content, sidePath(item, side)), ...same].filter(({ status }) => status === 'open').map((conversation) => {
      const start = conversation.location?.startLine ?? conversation.anchor.startLine;
      const end = conversation.location?.endLine ?? conversation.anchor.endLine;
      const metadata: CommentMetadata = {
        kind: 'saved',
        key: conversation.id,
        conversationId: conversation.id,
        range: { start, end, side, endSide: side },
      };
      return item.type === 'file' ? { lineNumber: end, metadata } : { side, lineNumber: end, metadata };
    });
  });
}

function annotationSignature(annotations: readonly ConversationAnnotation[]): string {
  return annotations
    .map((annotation) => `${annotation.metadata.key}:${'side' in annotation ? annotation.side : ''}:${String(annotation.lineNumber)}`)
    .join('|');
}

export interface GitnaViewerActions {
  cacheNamespace: string;
  canOpenFile(path: string): boolean;
  onRevealFile: (path: string) => void;
  kindForPath(path: string): ChangeKind | undefined;
  loadDiff(path: string): Promise<FileDiff>;
  onFileAction: (action: GitnaFileAction, path: string, kind: ChangeKind) => void;
  onOpenFile: (path: string) => void;
  onPatch: (request: MutateRequest) => Promise<void>;
  onError: (error: string) => void;
  disabledReason?: string | null;
  scope: 'staged' | 'unstaged';
}

// Content loads own the integer versions. In-place updates step between them,
// so the next load of the same item is never mistaken for one already shown.
export function getNextItemVersion(item: CodeViewItem<CommentMetadata>): number {
  return (typeof item.version === 'number' ? item.version : 0) + 2 ** -16;
}

interface ActiveDraftComment {
  itemId: string;
  key: string;
}

interface DiffsHubViewerProps {
  className?: string;
  diffStyle: 'split' | 'unified';
  overflow: 'wrap' | 'scroll';
  showBackgrounds: boolean;
  diffIndicators: DiffIndicators;
  lineNumbers: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  themeType: ThemeTypes;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>;
  initialItems: CodeViewItem<CommentMetadata>[];
  loadDiffFiles?: FileDiffContentsLoader;
  onScroll?: (scrollTop: number) => void;
  onViewerReady: () => void;
  onEditorReady?: () => void;
  searchMatches?: readonly ContentSearchMatch[];
  activeSearchMatch?: ActiveSearchMatch;
  gitnaActions?: GitnaViewerActions;
  gitnaComparisonActions?: GitnaComparisonActions;
  gitnaEditorActions?: GitnaEditorActions;
  gitnaOpenFileAction?: GitnaOpenFileAction;
  gitnaConversations?: GitnaConversationActions;
  onDraftChange?: (open: boolean) => void;
}

export const DiffsHubViewer = memo(function DiffsHubViewer({
  className,
  diffStyle,
  overflow,
  showBackgrounds,
  diffIndicators,
  lineNumbers,
  scrollRef,
  themeType,
  viewerRef,
  initialItems,
  loadDiffFiles,
  onScroll,
  onViewerReady,
  onEditorReady,
  searchMatches,
  activeSearchMatch,
  gitnaActions,
  gitnaComparisonActions,
  gitnaEditorActions,
  gitnaOpenFileAction,
  gitnaConversations,
  onDraftChange,
}: DiffsHubViewerProps) {
  useEffect(() => {
    const container = scrollRef.current;
    if (container == null || searchMatches == null || searchMatches.length === 0) return;
    return installSearchHighlights(container, searchMatches, activeSearchMatch);
  }, [scrollRef, searchMatches, activeSearchMatch]);
  const handleEditorReady = useStableCallback(() => onEditorReady?.());
  // CodeView treats a new key resolver as changed options and rerenders the
  // editable DOM. Keep it stable when connection/header state changes.
  const getEditStateKey = useStableCallback((item: CodeViewItem<CommentMetadata>) => `worktree:${item.id}`);
  const editorOptions = useMemo(
    () => ({ onAttach: handleEditorReady }) satisfies EditorOptions<'file' | 'file-diff', CommentMetadata, undefined>,
    [handleEditorReady]
  );
  const nextCommentKeyRef = useRef(0);
  const activeDraftRef = useRef<ActiveDraftComment | null>(null);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
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

  const handleViewerRef = useStableCallback(
    (viewer: CodeViewHandle<CommentMetadata, undefined> | null) => {
      viewerRef.current = viewer;
      if (viewer != null) {
        onViewerReady();
        syncConversationAnnotations();
      }
    }
  );

  const setItemAnnotations = (
    viewer: CodeViewHandle<CommentMetadata, undefined>,
    item: ConversationViewItem,
    keep: (metadata: CommentMetadata) => boolean,
    added: readonly ConversationAnnotation[]
  ) => {
    if (item.type === 'file') {
      item.annotations = [...(item.annotations ?? []).filter((annotation) => keep(annotation.metadata)), ...added];
    } else {
      item.annotations = [
        ...(item.annotations ?? []).filter((annotation) => keep(annotation.metadata)),
        ...(added as DiffLineAnnotation<CommentMetadata>[]),
      ];
    }
    item.version = getNextItemVersion(item);
    viewer.updateItem(item);
  };

  const syncConversationItem = useStableCallback((id: string, refreshDrafts = false) => {
    const { current: viewer } = viewerRef;
    const item = viewer?.getItem(id);
    if (viewer == null || item == null || (item.type !== 'file' && item.type !== 'diff')) return;
    const next = gitnaConversations?.visible ? conversationAnnotations(item, gitnaConversations) : [];
    const current = (item.annotations ?? []).filter((annotation) => annotation.metadata.kind === 'saved');
    const refreshDraft = refreshDrafts && item.annotations?.some((annotation) => annotation.metadata.kind === 'draft');
    if (annotationSignature(current) === annotationSignature(next) && !refreshDraft) return;
    setItemAnnotations(viewer, item, (metadata) => metadata.kind !== 'saved', next);
  });

  const syncConversationAnnotations = useStableCallback((refreshDrafts = false) => {
    for (const { id } of initialItems) syncConversationItem(id, refreshDrafts);
  });

  useEffect(() => {
    syncConversationAnnotations();
    return gitnaConversations?.model.subscribe(syncConversationAnnotations);
  }, [gitnaConversations, initialItems, syncConversationAnnotations]);

  useEffect(() => {
    queueMicrotask(() => syncConversationAnnotations(true));
  }, [gitnaConversations?.visible, syncConversationAnnotations]);

  // Comment affordances exist only where a saved comment is a real conversation.
  const commenting = gitnaConversations?.visible === true;

  const conversationAnchor = (item: ConversationViewItem, range: SelectedLineRange): ConversationAnchor | null => {
    const surface = gitnaConversations?.surface;
    const side: ConversationSide = item.type === 'file' ? 'additions' : (range.endSide ?? range.side ?? 'additions');
    const content = surface?.[side];
    if (surface == null || content == null) return null;
    // A conversation belongs to one side's content; old and new line numbers
    // cannot form one range, so such a selection is refused, not truncated.
    if (item.type === 'diff' && range.side != null && range.endSide != null && range.side !== range.endSide) {
      gitnaConversations?.model.reportError('Select lines on one side of the diff to start a conversation.');
      return null;
    }
    const endLine = Math.max(range.start, range.end);
    const startLine = Math.min(range.start, range.end);
    // Views holding the whole file record what the reader saw, including
    // unsaved edits; otherwise Gitna reads the lines from the content itself.
    let lines: readonly string[] | undefined;
    if (item.type === 'file') {
      lines = (viewerRef.current?.getEditor(item.id)?.getText() ?? item.file.contents).split('\n');
    } else if (!item.fileDiff.isPartial) {
      lines = side === 'deletions' ? item.fileDiff.deletionLines : item.fileDiff.additionLines;
    }
    const opposite = surface[side === 'additions' ? 'deletions' : 'additions'];
    return {
      ...content,
      path: sidePath(item, side),
      view: surface.view,
      against: opposite?.source === 'commit' ? opposite.revision : undefined,
      side,
      startLine,
      endLine,
      ...(lines == null ? {} : captureLines(lines, startLine, endLine)),
    };
  };

  const handleCreateDraftComment = useStableCallback(
    (range: SelectedLineRange, itemId: string) => {
      const { current: viewer } = viewerRef;
      const item = viewer?.getItem(itemId);
      if (viewer == null || item == null || (item.type !== 'file' && item.type !== 'diff')) {
        return;
      }
      const anchor = conversationAnchor(item, range);
      if (anchor == null) {
        return;
      }
      const side = range.endSide ?? range.side ?? 'additions';
      const lineNumber = Math.max(range.start, range.end);
      const code = anchor.code ?? shownCode(item, side, Math.min(range.start, range.end), lineNumber) ?? '';
      const metadata: CommentMetadata = {
        kind: 'draft',
        key: `draft-${nextCommentKeyRef.current++}`,
        message: '',
        range,
        code,
        anchor: { ...anchor, code },
      };

      const { current: activeDraft } = activeDraftRef;
      const previous = activeDraft == null ? undefined : viewer.getItem(activeDraft.itemId);
      if (activeDraft != null && previous != null && activeDraft.itemId !== itemId && (previous.type === 'file' || previous.type === 'diff')) {
        setItemAnnotations(viewer, previous, (existing) => existing.key !== activeDraft.key, []);
      }
      setItemAnnotations(viewer, item, (existing) => !isDraftMetadata(existing), [
        item.type === 'file' ? { lineNumber, metadata } : { side, lineNumber, metadata },
      ]);
      activeDraftRef.current = { itemId, key: metadata.key };
      onDraftChange?.(true);
    }
  );

  const handleRemoveDraft = useStableCallback(
    (itemId: string, key: string) => {
      const { current: viewer } = viewerRef;
      const item = viewer?.getItem(itemId);
      if (viewer != null && item != null && (item.type === 'file' || item.type === 'diff')) {
        setItemAnnotations(viewer, item, (metadata) => metadata.key !== key, []);
      }
      const { current: activeDraft } = activeDraftRef;
      if (activeDraft?.itemId === itemId && activeDraft.key === key) {
        activeDraftRef.current = null;
        onDraftChange?.(false);
      }
      setSelectedLines(null);
    }
  );

  const handleSaveDraft = useStableCallback(
    async (itemId: string, key: string, message: string, to?: string) => {
      const item = viewerRef.current?.getItem(itemId);
      const draft = item?.annotations?.find((annotation) => annotation.metadata.key === key)?.metadata;
      if (gitnaConversations == null || item == null || draft?.kind !== 'draft') {
        return;
      }
      const anchor = draft.outdated === true ? draft.anchor : conversationAnchor(item, draft.range);
      if (anchor == null) {
        return;
      }
      const unsaved =
        anchor.source === 'worktree' &&
        (gitnaEditorActions?.dirtyPaths.has(anchor.path) === true ||
          (gitnaComparisonActions != null &&
            (anchor.side === 'deletions' ? gitnaComparisonActions.leftDirty : gitnaComparisonActions.rightDirty)));
      if (unsaved) {
        throw new Error(`Save ${anchor.path} before starting a conversation on it.`);
      }
      await gitnaConversations.model.create(anchor, message, to == null ? undefined : [to]);
      handleRemoveDraft(itemId, key);
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
      _file: FileContents | FileDiffMetadata,
      item: CodeViewItem<CommentMetadata>
    ) => {
      const { metadata } = annotation;
      if (gitnaConversations == null) {
        return null;
      }
      if (metadata.kind === 'draft') {
        return (
          <div hidden={!gitnaConversations.visible}>
            <DraftAnnotation
              annotation={annotation as DiffLineAnnotation<DraftCommentMetadata>}
              author={gitnaConversations.model.participant?.name ?? 'You'}
              itemId={item.id}
              recipients={gitnaConversations.model.recipients()}
              onCancel={handleRemoveDraft}
              onSave={handleSaveDraft}
            />
          </div>
        );
      }
      if (metadata.kind !== 'saved' || !gitnaConversations.visible) {
        return null;
      }
      const conversation = gitnaConversations.model.find(metadata.conversationId);
      return conversation == null ? null : (
        <ConversationThread conversation={conversation} model={gitnaConversations.model} />
      );
    }
  );

  const renderBody = useStableCallback((item: CodeViewItem<CommentMetadata>) => {
    const preview = item.annotations?.find((annotation) => annotation.metadata.kind === 'preview')?.metadata;
    if (preview?.kind === 'preview') {
      return <p className="px-4 py-6 text-sm text-muted-foreground" role="note">{preview.message}</p>;
    }
    const images = item.annotations?.flatMap((annotation) =>
      annotation.metadata.kind === 'image'
        ? [{ metadata: annotation.metadata, side: 'side' in annotation ? annotation.side : undefined }]
        : []
    );
    if (images == null || images.length === 0) return null;
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

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type === 'file' && gitnaEditorActions != null) {
        return <WorktreeHeaderActions actions={gitnaEditorActions} path={item.file.name} />;
      }
      if (item.type !== 'diff') return null;
      if (gitnaComparisonActions != null) {
        const dirtySides = [
          gitnaComparisonActions.leftDirty
            ? `${gitnaComparisonActions.leftPath} (Unsaved)`
            : null,
          gitnaComparisonActions.rightDirty
            ? `${gitnaComparisonActions.rightPath} (Unsaved)`
            : null,
        ].filter((value): value is string => value != null);
        return (
          <div className="flex items-center gap-2">
            {dirtySides.length > 0 && (
              <span className="max-w-72 truncate text-xs text-muted-foreground" title={dirtySides.join(', ')}>
                Unsaved: {dirtySides.join(', ')}
              </span>
            )}
            <FileHeaderAction
              type="button"
              aria-label="Swap compared files"
              onClick={gitnaComparisonActions.onSwap}
            >
              Swap sides
            </FileHeaderAction>
          </div>
        );
      }
      if (gitnaActions != null) return (
        <GitnaHeaderActions
          key={JSON.stringify([gitnaActions.cacheNamespace, gitnaActions.scope, item.id])}
          actions={gitnaActions}
          item={item}
        />
      );
      if (gitnaOpenFileAction == null) return null;
      const path = item.fileDiff.name;
      if (!gitnaOpenFileAction.canOpenFile(path)) return null;
      return (
        <FileHeaderAction
          type="button"
          aria-label={gitnaOpenFileAction.ariaLabel(path)}
          onClick={() => gitnaOpenFileAction.onOpenFile(path)}
        >
          Open File
        </FileHeaderAction>
      );
    },
    [gitnaEditorActions, gitnaComparisonActions, gitnaActions, gitnaOpenFileAction]
  );

  const renderHeaderPrefix = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type !== 'diff') {
        return null;
      }

      return (
        <CollapseDiffButton
          disabled={
            !item.annotations?.some((annotation) => annotation.metadata.kind === 'image' || annotation.metadata.kind === 'preview') &&
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
  const options: CodeViewOptions<CommentMetadata, undefined> = useMemo(
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
        enableLineSelection: commenting,
        enableGutterUtility: commenting,
        stickyHeaders: true,
        // Avoid invalidating every rendered file's styles on each scroll event.
        pointerEventsOnScroll: true,
        unsafeCSS: CODE_VIEW_CUSTOM_CSS,
        // FIXME(amadeus): Move all `onX` methods onto the react component maybe?
        onGutterUtilityClick: commenting
          ? (range, context) => handleCreateDraftComment(range, context.item.id)
          : undefined,
        // The review UI may replace items after this component's effects run;
        // restore conversation threads on whatever item was just rendered.
        onPostRender: gitnaConversations != null
          ? (_node: HTMLElement, _instance: unknown, _phase: unknown, context: { item: { id: string } }) => {
              queueMicrotask(() => syncConversationItem(context.item.id));
            }
          : undefined,
      }) satisfies CodeViewOptions<CommentMetadata, undefined>,
    [
      commenting,
      diffIndicators,
      diffStyle,
      gitnaConversations,
      handleCreateDraftComment,
      syncConversationItem,
      lineNumbers,
      loadDiffFiles,
      overflow,
      showBackgrounds,
      themeType,
    ]
  );
  const handleItemEditChange = useStableCallback(
    (event: EditorChangeEvent<EditorType, CommentMetadata, undefined>, item: CodeViewItem<CommentMetadata>) => {
      gitnaEditorActions?.onChange(item.id, event.file, event.editor.getViewState());
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
        'cv-scrollbar relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain border-b border-border w-full [contain:strict] [overflow-anchor:none] [will-change:scroll-position] md:border-b-0 [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style]'
      )}
      options={options}
      editorOptions={editorOptions}
      getEditStateKey={getEditStateKey}
      onItemEditChange={gitnaEditorActions == null ? undefined : handleItemEditChange}
      onItemEditComplete={() => 'accept'}
      onScroll={(scrollTop) => onScroll?.(scrollTop)}
      style={annotationThemeStyle}
      selectedLines={commenting ? selectedLines : null}
      onSelectedLinesChange={handleSetSelection}
      renderAnnotation={renderCommentAnnotation}
      renderBody={renderBody}
      renderHeaderMetadata={renderHeaderMetadata}
      renderHeaderPrefix={renderHeaderPrefix}
      />
    </EditProvider>
  );
});



function createWorktreeEditor<EType extends EditorType>(
  editorType: EType,
  options: EditorOptions<EType, CommentMetadata, undefined>,
  editStateKey?: string
) {
  return new Editor(editorType, options, editStateKey);
}

export function FileHeaderAction({ className, ...props }: ComponentProps<typeof Button>) {
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
  const savingVisible = useLoadingIndicator(dirty && actions.saving, path);
  const recentlySaved = actions.recentlySavedPath === path;
  const previewMode = actions.previewMode;
  const scopes = actions.changeScopes(path);
  const openChange = (scope: ChangeScope) => actions.onOpenChange(scope, path);
  let saveLabel: ReactNode = 'Save';
  if (savingVisible) saveLabel = 'Saving…';
  else if (!dirty && recentlySaved) {
    saveLabel = (
      <span className="flex items-center gap-1" role="status">
        <IconCheck className="size-3" />
        Saved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      {previewMode != null && actions.onPreviewModeChange != null && (
        <>
          <FileHeaderAction
            type="button"
            aria-label={
              previewMode === 'preview'
                ? 'Return to editor'
                : `Open ${actions.previewLabel ?? 'Markdown'} preview`
            }
            title={
              previewMode === 'preview'
                ? 'Return to editor'
                : `Open ${actions.previewLabel ?? 'Markdown'} preview`
            }
            aria-pressed={previewMode === 'preview'}
            className={previewMode === 'preview' ? 'bg-accent text-foreground' : undefined}
            onClick={() =>
              actions.onPreviewModeChange?.(previewMode === 'preview' ? 'editor' : 'preview')
            }
          >
            <IconEye className="size-3" />
          </FileHeaderAction>
          <FileHeaderAction
            type="button"
            aria-label={
              previewMode === 'split'
                ? 'Close preview'
                : `Open ${actions.previewLabel ?? 'Markdown'} preview to the side`
            }
            title={
              previewMode === 'split'
                ? 'Close preview'
                : `Open ${actions.previewLabel ?? 'Markdown'} preview to the side`
            }
            aria-pressed={previewMode === 'split'}
            className={previewMode === 'split' ? 'bg-accent text-foreground' : undefined}
            onClick={() =>
              actions.onPreviewModeChange?.(previewMode === 'split' ? 'editor' : 'split')
            }
          >
            <IconDiffSplit className="size-3" />
          </FileHeaderAction>
        </>
      )}
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
        disabled={!dirty || actions.saving || actions.disabledReason != null}
        tabIndex={dirty ? 0 : -1}
        aria-describedby={actions.disabledReason == null ? undefined : `gitna-action-reason-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
        title={dirty ? actions.disabledReason ?? `Save ${path}` : undefined}
        onClick={() => actions.onSave(path)}
      >
        {saveLabel}
      </FileHeaderAction>
      {dirty && actions.disabledReason != null && (
        <span
          id={`gitna-action-reason-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
          className="sr-only"
          role="note"
        >
          {actions.disabledReason}
        </span>
      )}
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

function sameHunkTarget(before: FileDiffMetadata, after: FileDiffMetadata): boolean {
  return before === after || (
    before.name === after.name && before.prevName === after.prevName &&
    before.type === after.type && before.mode === after.mode && before.prevMode === after.prevMode &&
    before.newObjectId === after.newObjectId && before.prevObjectId === after.prevObjectId &&
    before.isPartial === after.isPartial &&
    before.additionLines.length === after.additionLines.length &&
    before.deletionLines.length === after.deletionLines.length &&
    before.additionLines.every((line, index) => line === after.additionLines[index]) &&
    before.deletionLines.every((line, index) => line === after.deletionLines[index]) &&
    before.hunks.length === after.hunks.length &&
    before.hunks.every((hunk, index) => {
      const next = after.hunks[index];
      return areObjectsEqual(hunk, next, ['hunkContent']) &&
        hunk.hunkContent.length === next.hunkContent.length &&
        hunk.hunkContent.every((segment, segmentIndex) => areObjectsEqual(segment, next.hunkContent[segmentIndex]));
    })
  );
}

function GitnaHeaderActions({
  actions,
  item,
}: {
  actions: GitnaViewerActions;
  item: CodeViewDiffItem<CommentMetadata>;
}) {
  const [target, setTarget] = useState({ diff: item.fileDiff, revision: 0 });
  if (target.diff !== item.fileDiff) {
    setTarget({
      diff: item.fileDiff,
      revision: target.revision + (sameHunkTarget(target.diff, item.fileDiff) ? 0 : 1),
    });
  }
  const revision = target.revision;
  const [loaded, setLoaded] = useState<{
    revision: number;
    hunks: ReturnType<typeof splitHunkPatches>;
    patchId: string | null;
  } | null>(null);
  const hunks = loaded?.revision === revision ? loaded.hunks : null;
  const patchId = loaded?.revision === revision ? loaded.patchId : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const path = item.fileDiff.name;
  const requestId = useRef(0);
  const loadingVisible = useLoadingIndicator(loading, `${actions.scope}\u0000${path}`);
  useEffect(() => {
    setLoading(false);
    setLoaded(null);
    return () => { requestId.current++; };
  }, [revision]);
  const kind = actions.kindForPath(path) ?? inferGitnaKind(item);
  const primary = actions.scope === 'staged' ? 'unstage' : 'stage';
  const primaryLabel = actions.scope === 'staged' ? 'Unstage' : 'Stage';
  const destructive = kind === 'untracked' ? 'delete' : 'discard';
  const destructiveLabel = kind === 'untracked' ? 'Delete' : 'Discard';

  const loadHunks = async () => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const diff = await actions.loadDiff(path);
      if (request !== requestId.current) return;
      const next = splitHunkPatches(diff.patch ?? '');
      setLoaded({ revision, patchId: diff.patchId ?? null, hunks: next });
    } catch (error) {
      if (request === requestId.current) actions.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  };

  const applyHunk = async (index: number, patch: string) => {
    const request = ++requestId.current;
    setMenuOpen(false);
    try {
      const diff = await actions.loadDiff(path);
      if (request !== requestId.current) return;
      if (diff.patchId == null || splitHunkPatches(diff.patch ?? '')[index]?.patch !== patch) {
        throw new Error('The hunk changed. Reload hunk actions before trying again.');
      }
      await actions.onPatch({
        op: 'patch', patch, patchId: diff.patchId,
        scope: actions.scope, path, reverse: actions.scope === 'staged',
      });
    } catch (error) {
      if (request !== requestId.current) return;
      setLoaded(null);
      actions.onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <FileHeaderAction
        type="button"
        disabled={actions.disabledReason != null}
        aria-label={`${primaryLabel} file ${path}${actions.disabledReason == null ? '' : `. ${actions.disabledReason}`}`}
        title={actions.disabledReason ?? undefined}
        onClick={() => actions.onFileAction(primary, path, kind)}
      >
        {primaryLabel}
      </FileHeaderAction>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          asChild
          onKeyDown={(event) => {
            // Keep review navigation from also opening Radix's ArrowDown menu.
            if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
            }
          }}
        >
          <FileHeaderAction type="button" aria-label={`More actions for ${path}`}>
            More
          </FileHeaderAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
          <span className="block px-2 py-1 text-xs break-all text-muted-foreground">{path}</span>
          {actions.canOpenFile(path) && (
            <DropdownMenuItem aria-label={`Open ${path} in Repository`} onSelect={() => actions.onOpenFile(path)}>Open File</DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={actions.disabledReason != null || !actions.canOpenFile(path)} onSelect={() => actions.onRevealFile(path)}>Reveal in File Manager</DropdownMenuItem>
          {actions.scope === 'unstaged' && (
            <DropdownMenuItem
              disabled={actions.disabledReason != null}
              onSelect={() => actions.onFileAction(destructive, path, kind)}
            >
              {destructiveLabel}
            </DropdownMenuItem>
          )}
          {item.fileDiff.hunks.length > 0 && kind === 'modified' && hunks == null && (
            <DropdownMenuItem aria-label={`Show hunk actions for ${path}`} disabled={loading} onSelect={() => { setMenuOpen(false); void loadHunks(); }}>
              {loadingVisible ? 'Loading…' : 'Show hunk actions'}
            </DropdownMenuItem>
          )}
          {hunks?.map((hunk, index) => (
            <DropdownMenuItem
              key={hunk.range}
              disabled={patchId == null || actions.disabledReason != null}
              aria-label={`${primaryLabel} hunk ${index + 1} in ${path}${actions.disabledReason == null ? '' : `. ${actions.disabledReason}`}`}
              title={actions.disabledReason ?? hunk.range}
              onSelect={() => { if (patchId != null) void applyHunk(index, hunk.patch); }}
            >
              {primaryLabel} hunk {index + 1}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.disabledReason != null && (
        <span className="sr-only" role="note">
          {actions.disabledReason}
        </span>
      )}
    </span>
  );
}

interface CollapseDiffButtonProps {
  disabled?: boolean;
  collapsed?: boolean;
  onToggle: () => void;
}

function CollapseDiffButton({
  disabled = false,
  collapsed = false,
  onToggle,
}: CollapseDiffButtonProps) {
  let ariaLabel: string | undefined;
  if (!disabled) ariaLabel = collapsed ? 'Expand diff' : 'Collapse diff';
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={!disabled && !collapsed}
      aria-hidden={disabled}
      aria-label={ariaLabel}
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
