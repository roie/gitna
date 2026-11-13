import type { CodeViewItem, DiffLineAnnotation, LineAnnotation } from '@pierre/diffs';

import type { ConversationSide } from '../../lib/conversations';
import type { CommentMetadata, DraftCommentMetadata } from './types';

type DraftAnnotation = LineAnnotation<DraftCommentMetadata> | DiffLineAnnotation<DraftCommentMetadata>;

/** Runs of consecutive line numbers that an item shows on one side. */
function shownLines(item: CodeViewItem<CommentMetadata>, side: ConversationSide): { first: number; lines: string[] }[] {
  const clean = (lines: readonly string[]) => lines.map((line) => line.replace(/[\r\n]+$/, ''));
  if (item.type === 'file') return [{ first: 1, lines: clean(item.file.contents.split('\n')) }];
  if (item.type !== 'diff') return [];
  const diff = item.fileDiff;
  const lines = side === 'deletions' ? diff.deletionLines : diff.additionLines;
  if (!diff.isPartial) return [{ first: 1, lines: clean(lines) }];
  return diff.hunks.map((hunk) => {
    const [first, index, count] =
      side === 'deletions'
        ? [hunk.deletionStart, hunk.deletionLineIndex, hunk.deletionCount]
        : [hunk.additionStart, hunk.additionLineIndex, hunk.additionCount];
    return { first, lines: clean(lines.slice(index, index + count)) };
  });
}

export function draftSide(draft: DraftCommentMetadata): ConversationSide {
  return draft.range.endSide ?? draft.range.side ?? 'additions';
}

/** The text of lines start..end as the item shows them, or null when it does not show them all. */
export function shownCode(item: CodeViewItem<CommentMetadata>, side: ConversationSide, start: number, end: number): string | null {
  const run = shownLines(item, side).find(({ first, lines }) => start >= first && end < first + lines.length);
  return run == null ? null : run.lines.slice(start - run.first, end - run.first + 1).join('\n');
}

/**
 * Places a draft on a refreshed item: where it was when its lines still hold
 * its code, on the only other lines that hold exactly that code, or otherwise
 * outdated on the nearest shown line, never on other code as if it were its own.
 */
export function relocateDraft(item: CodeViewItem<CommentMetadata>, annotation: DraftAnnotation): DraftAnnotation {
  const draft = annotation.metadata;
  const side = draftSide(draft);
  const start = Math.min(draft.range.start, draft.range.end);
  const end = Math.max(draft.range.start, draft.range.end);
  if (shownCode(item, side, start, end) === draft.code) {
    return draft.outdated === true ? { ...annotation, lineNumber: end, metadata: { ...draft, outdated: false } } : annotation;
  }
  const runs = shownLines(item, side);
  const height = end - start + 1;
  const matches = runs.flatMap(({ first, lines }) =>
    lines.flatMap((_, index) =>
      index + height <= lines.length && lines.slice(index, index + height).join('\n') === draft.code ? [first + index] : []
    )
  );
  if (matches.length === 1) {
    const shift = matches[0]! - start;
    const range = { ...draft.range, start: draft.range.start + shift, end: draft.range.end + shift };
    return { ...annotation, lineNumber: end + shift, metadata: { ...draft, range, outdated: false } };
  }
  const target = annotation.lineNumber;
  const nearest = runs
    .filter(({ lines }) => lines.length > 0)
    .map(({ first, lines }) => Math.min(Math.max(target, first), first + lines.length - 1))
    .reduce<number | null>((best, line) => (best == null || Math.abs(line - target) < Math.abs(best - target) ? line : best), null);
  return {
    ...annotation,
    lineNumber: nearest ?? target,
    metadata: { ...draft, outdated: true },
  };
}
