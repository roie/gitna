// Modified by Gitna: describe persistent conversations and local review data.
import type { AnnotationSide, SelectedLineRange } from '@pierre/diffs';
import type { GitStatusEntry } from '@pierre/trees';

import type { ConversationAnchor } from './conversations';
import type { ImageContent } from './types';

export type ViewerLoadState =
  | 'fetching'
  | 'streaming'
  | 'parsing'
  | 'ready'
  | 'error';

export interface SavedCommentMetadata {
  kind: 'saved';
  key: string;
  /** The persisted Gitna conversation this annotation shows. */
  conversationId: string;
  range: SelectedLineRange;
}

export interface DraftCommentMetadata {
  kind: 'draft';
  key: string;
  message: string;
  /** Recipients picked from the To line; mentions in the message add to them. */
  to?: string[];
  range: SelectedLineRange;
  /** The selected lines as they were when the draft was started. */
  code: string;
  /** The anchor captured when the draft was started, saved once the code is gone. */
  anchor: ConversationAnchor;
  /** The selected lines no longer hold `code` and it has no single new place. */
  outdated?: boolean;
}

export interface ImageAnnotationMetadata {
  kind: 'image';
  key: string;
  alt: string;
  image: ImageContent;
}

export type CommentMetadata =
  | SavedCommentMetadata
  | DraftCommentMetadata
  | ImageAnnotationMetadata
  | { kind: 'preview'; key: string; message: string };

export interface DiffsHubCommentSidebarFile {
  fileOrder: number;
  path: string;
}

export type DiffsHubCommentFileByItemId = ReadonlyMap<
  string,
  DiffsHubCommentSidebarFile
>;

// Whether the line the comment is anchored to is a real addition/deletion or
// an unchanged context line shown in the diff. Tracked so the sidebar can
// render "Line N" without a misleading + / - sigil for context lines.
export type CommentLineType = 'change' | 'context';

export interface DiffsHubSavedCommentEntry {
  author: string;
  itemId: string;
  key: string;
  lineNumber: number;
  lineType: CommentLineType;
  message: string;
  range: SelectedLineRange;
  side: AnnotationSide;
}

export interface DiffsHubSavedCommentItem {
  comments: DiffsHubSavedCommentEntry[];
  fileOrder: number;
  itemId: string;
  path: string;
}

// The fully pre-computed input this tree needs for a given fetch. It is built
// once at fetch time by snapshotReviewData and stored alongside the
// viewer items, so later per-item annotation updates do not feed into the
// tree and do not cause it to rebuild.
//
// `paths` and `pathToItemId` may alias the live accumulator state for
// streamed sources, so consumers must treat them as read-only and must use
// `pathCount` (captured at snapshot time) as the exclusive upper bound when
// iterating `paths`. The `readonly` markers and ReadonlyMap type enforce the
// read-only side; pathCount is what keeps later in-place growth invisible to
// this snapshot.
export interface DiffsHubFileTreeSource {
  gitStatus: readonly GitStatusEntry[];
  pathCount: number;
  paths: readonly string[];
  pathToItemId: ReadonlyMap<string, string>;
  itemIdToPath?: ReadonlyMap<string, string>;
}

export interface DiffsHubDiffStats {
  addedLines: number;
  deletedLines: number;
  fileCount: number;
  totalLinesOfCode: number;
}
