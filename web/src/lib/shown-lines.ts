import type { CodeViewItem } from '@pierre/diffs'
import type { ConversationSide } from './conversations'
import type { CommentMetadata } from './review-types'

/** Runs of consecutive line numbers that an item shows on one side. */
export function shownLines(
  item: CodeViewItem<CommentMetadata>,
  side: ConversationSide,
): { first: number; lines: string[] }[] {
  const clean = (lines: readonly string[]) => lines.map((line) => line.replace(/[\r\n]+$/, ''))
  if (item.type === 'file') return [{ first: 1, lines: clean(item.file.contents.split('\n')) }]
  if (item.type !== 'diff') return []
  const diff = item.fileDiff
  const lines = side === 'deletions' ? diff.deletionLines : diff.additionLines
  if (!diff.isPartial) return [{ first: 1, lines: clean(lines) }]
  return diff.hunks.map((hunk) => {
    const [first, index, count] =
      side === 'deletions'
        ? [hunk.deletionStart, hunk.deletionLineIndex, hunk.deletionCount]
        : [hunk.additionStart, hunk.additionLineIndex, hunk.additionCount]
    return { first, lines: clean(lines.slice(index, index + count)) }
  })
}

/** The text of lines start..end as the item shows them, or null when it does not show them all. */
export function shownCode(
  item: CodeViewItem<CommentMetadata>,
  side: ConversationSide,
  start: number,
  end: number,
): string | null {
  const run = shownLines(item, side).find(
    ({ first, lines }) => start >= first && end < first + lines.length,
  )
  return run == null ? null : run.lines.slice(start - run.first, end - run.first + 1).join('\n')
}
