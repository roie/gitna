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

export function installChangeGutter(container: HTMLElement) {
  let changes: ReadonlyMap<number, GutterChange> = new Map()
  let frame: number | undefined
  const roots = new Map<ShadowRoot, MutationObserver>()
  const schedule = () => {
    if (frame == null) frame = requestAnimationFrame(paint)
  }
  const discover = () => {
    for (const [root, observer] of roots) {
      if (!root.host.isConnected) {
        observer.disconnect()
        roots.delete(root)
      }
    }
    for (const host of container.querySelectorAll('diffs-container')) {
      const root = host.shadowRoot
      if (root == null || roots.has(root)) continue
      const observer = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              (record.target instanceof Element &&
                record.target.closest('[data-gutter]') != null) ||
              [...record.addedNodes, ...record.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches('[data-gutter], [data-column-number]') ||
                    node.querySelector('[data-gutter], [data-column-number]') != null),
              ),
          )
        )
          schedule()
      })
      observer.observe(root, { childList: true, subtree: true })
      roots.set(root, observer)
    }
  }
  const observer = new MutationObserver(schedule)
  observer.observe(container, { childList: true, subtree: true })
  function attribute(row: Element, name: string, value: string | undefined) {
    if (value == null) {
      if (row.hasAttribute(name)) row.removeAttribute(name)
    } else if (row.getAttribute(name) !== value) row.setAttribute(name, value)
  }
  function paint() {
    frame = undefined
    discover()
    for (const root of roots.keys()) {
      for (const row of root.querySelectorAll('[data-gutter] > [data-column-number]')) {
        const change = changes.get(Number(row.getAttribute('data-column-number')))
        attribute(row, 'data-gitna-change', change?.kind)
        attribute(row, 'data-gitna-deletion', change?.deletion)
      }
    }
  }
  schedule()
  return {
    update(next: ReadonlyMap<number, GutterChange>) {
      changes = next
      schedule()
    },
    dispose() {
      if (frame != null) cancelAnimationFrame(frame)
      changes = new Map()
      paint()
      observer.disconnect()
      for (const rootObserver of roots.values()) rootObserver.disconnect()
      roots.clear()
    },
  }
}
