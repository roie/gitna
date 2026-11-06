import { parseDiffFromFile } from '@pierre/diffs'

export interface GutterChange {
  kind?: 'added' | 'modified'
  deletion?: 'before' | 'after'
}

export function fileGutterChanges(before: string, after: string): Map<number, GutterChange> {
  const changes = new Map<number, GutterChange>()
  if (before === after) return changes
  const diff = parseDiffFromFile(
    { name: 'file', contents: before },
    { name: 'file', contents: after },
    { disableLineMatching: true },
  )
  for (const hunk of diff.hunks) {
    let line = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        line += content.lines
        continue
      }
      for (let offset = 0; offset < content.additions; offset++) {
        changes.set(line + offset, { kind: content.deletions > 0 ? 'modified' : 'added' })
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

export function installChangeGutter(
  container: HTMLElement,
  changes: ReadonlyMap<number, GutterChange>,
): () => void {
  let frame: number | undefined
  const observer = new MutationObserver(() => {
    if (frame == null) frame = requestAnimationFrame(paint)
  })
  function paint() {
    frame = undefined
    observer.disconnect()
    observer.observe(container, { childList: true, subtree: true })
    for (const host of container.querySelectorAll('diffs-container')) {
      const root = host.shadowRoot
      if (root == null) continue
      observer.observe(root, { childList: true, subtree: true })
      for (const row of root.querySelectorAll('[data-gutter] > [data-column-number]')) {
        const change = changes.get(Number(row.getAttribute('data-column-number')))
        if (change?.kind == null) row.removeAttribute('data-gitna-change')
        else row.setAttribute('data-gitna-change', change.kind)
        if (change?.deletion == null) row.removeAttribute('data-gitna-deletion')
        else row.setAttribute('data-gitna-deletion', change.deletion)
      }
    }
  }
  paint()
  return () => {
    observer.disconnect()
    if (frame != null) cancelAnimationFrame(frame)
    for (const host of container.querySelectorAll('diffs-container')) {
      for (const row of host.shadowRoot?.querySelectorAll(
        '[data-gitna-change], [data-gitna-deletion]',
      ) ?? []) {
        row.removeAttribute('data-gitna-change')
        row.removeAttribute('data-gitna-deletion')
      }
    }
  }
}
