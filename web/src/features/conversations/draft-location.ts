// Modified by Gitna: keep unsent conversations anchored across review refreshes.
import type { CodeViewItem, DiffLineAnnotation, LineAnnotation } from '@pierre/diffs'

import { shownCode, shownLines } from '../../lib/shown-lines'
import type { ConversationSide } from '../../lib/conversations'
import type { CommentMetadata, DraftCommentMetadata } from '../../lib/review-types'

type DraftAnnotation =
  | LineAnnotation<DraftCommentMetadata>
  | DiffLineAnnotation<DraftCommentMetadata>

export function draftSide(draft: DraftCommentMetadata): ConversationSide {
  return draft.range.endSide ?? draft.range.side ?? 'additions'
}

/**
 * Places a draft on a refreshed item: where it was when its lines still hold
 * its code, on the only other lines that hold exactly that code, or otherwise
 * outdated on the nearest shown line, never on other code as if it were its own.
 */
export function relocateDraft(
  item: CodeViewItem<CommentMetadata>,
  annotation: DraftAnnotation,
): DraftAnnotation {
  const draft = annotation.metadata
  const side = draftSide(draft)
  const start = Math.min(draft.range.start, draft.range.end)
  const end = Math.max(draft.range.start, draft.range.end)
  if (shownCode(item, side, start, end) === draft.code) {
    return draft.outdated === true
      ? { ...annotation, lineNumber: end, metadata: { ...draft, outdated: false } }
      : annotation
  }
  const runs = shownLines(item, side)
  const height = end - start + 1
  const matches = runs.flatMap(({ first, lines }) =>
    lines.flatMap((_, index) =>
      index + height <= lines.length && lines.slice(index, index + height).join('\n') === draft.code
        ? [first + index]
        : [],
    ),
  )
  if (matches.length === 1) {
    const shift = matches[0]! - start
    const range = { ...draft.range, start: draft.range.start + shift, end: draft.range.end + shift }
    return {
      ...annotation,
      lineNumber: end + shift,
      metadata: { ...draft, range, outdated: false },
    }
  }
  const target = annotation.lineNumber
  const nearest = runs
    .filter(({ lines }) => lines.length > 0)
    .map(({ first, lines }) => Math.min(Math.max(target, first), first + lines.length - 1))
    .reduce<number | null>(
      (best, line) =>
        best == null || Math.abs(line - target) < Math.abs(best - target) ? line : best,
      null,
    )
  return {
    ...annotation,
    lineNumber: nearest ?? target,
    metadata: { ...draft, outdated: true },
  }
}
