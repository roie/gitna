import { parseDiffFromFile } from '@pierre/diffs'

export interface GutterChange {
  kind?: 'added' | 'modified'
  deletion?: 'before' | 'after'
}

export function fileGutterChanges(before: string, after: string): Map<number, GutterChange> {
  const changes = new Map<number, GutterChange>()
  if (before === after) return changes
  if (!before.slice(0, -1).includes('\n') && !after.slice(0, -1).includes('\n')) {
    changes.set(
      1,
      after === '' ? { deletion: 'before' } : { kind: before === '' ? 'added' : 'modified' },
    )
    return changes
  }
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const newLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let start = 0
  while (start < oldLines.length && oldLines[start] === newLines[start]) start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const diff = parseDiffFromFile(
    { name: 'file', contents: oldLines.slice(start, oldEnd).join('') },
    { name: 'file', contents: newLines.slice(start, newEnd).join('') },
    { disableLineMatching: true },
  )
  for (const hunk of diff.hunks) {
    let line = start + Math.max(1, hunk.additionStart)
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        line += content.lines
        continue
      }
      for (let offset = 0; offset < content.additions; offset++) {
        changes.set(line + offset, { kind: offset < content.deletions ? 'modified' : 'added' })
      }
      line += content.additions
      if (content.deletions > content.additions) {
        const anchor = Math.max(1, line - 1)
        changes.set(anchor, { ...changes.get(anchor), deletion: line <= 1 ? 'before' : 'after' })
      }
    }
  }
  return changes
}
