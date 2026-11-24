import type { ContentSearchMatch } from '../../lib/types'

export interface ActiveSearchMatch {
  line: number
  column: number
}

function textRange(line: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!started && start <= offset + length) {
      range.setStart(node, start - offset)
      started = true
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
  }
  return null
}

// Paint native ranges without changing Pierre's syntax DOM or editor selection.
// Rebuild when virtualization or tokenization replaces the rendered line nodes.
export function installSearchHighlights(
  container: HTMLElement,
  matches: readonly ContentSearchMatch[],
  selected?: ActiveSearchMatch,
): () => void {
  const highlights = new Highlight()
  const active = new Highlight()
  active.priority = 1
  CSS.highlights.set('gitna-search', highlights)
  CSS.highlights.set('gitna-search-active', active)
  const byLine = new Map<number, ContentSearchMatch[]>()
  for (const match of matches) {
    const line = byLine.get(match.line) ?? []
    line.push(match)
    byLine.set(match.line, line)
  }
  let frame: number | undefined
  const observer = new MutationObserver(() => {
    if (frame == null) frame = requestAnimationFrame(paint)
  })
  function paint() {
    frame = undefined
    observer.disconnect()
    highlights.clear()
    active.clear()
    observer.observe(container, { childList: true, subtree: true })
    for (const host of container.querySelectorAll('diffs-container')) {
      const root = host.shadowRoot
      if (root == null) continue
      observer.observe(root, { childList: true, subtree: true, characterData: true })
      for (const line of root.querySelectorAll('[data-line][data-line-type]')) {
        const lineMatches = byLine.get(Number(line.getAttribute('data-line')))
        if (lineMatches == null) continue
        for (const match of lineMatches) {
          const text = line.textContent ?? ''
          const expected = match.excerpt.slice(match.matchStart, match.matchEnd)
          // Search results refer to disk contents. Don't mark unrelated text after an edit.
          if (text.slice(match.column, match.column + expected.length) !== expected) continue
          const range = textRange(line, match.column, match.column + match.length)
          if (range == null) continue
          highlights.add(range)
          if (selected?.line === match.line && selected.column === match.column) active.add(range)
        }
      }
    }
  }
  paint()
  return () => {
    observer.disconnect()
    if (frame != null) cancelAnimationFrame(frame)
    CSS.highlights.delete('gitna-search')
    CSS.highlights.delete('gitna-search-active')
  }
}
