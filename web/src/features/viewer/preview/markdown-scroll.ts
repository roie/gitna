// Match rendered Markdown blocks to source lines; the two panes have different heights.
function anchors(article: HTMLElement): { line: number; element: HTMLElement }[] {
  const result: { line: number; element: HTMLElement }[] = []
  let previousLine = 1
  for (const element of article.querySelectorAll<HTMLElement>('[data-source-line]')) {
    const line = Number(element.dataset.sourceLine)
    if (line > previousLine) {
      result.push({ line, element })
      previousLine = line
    }
  }
  return result
}

function interpolate(value: number, from: number, to: number, start: number, end: number): number {
  return start + ((value - from) / (to - from)) * (end - start)
}

// Source blocks appear in document order. Only measure the blocks bracketing
// the requested position, rather than forcing layout for the whole preview.
function lowerBound(length: number, atOrAfter: (index: number) => boolean): number {
  let left = 0
  let right = length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (atOrAfter(middle)) right = middle
    else left = middle + 1
  }
  return left
}

function anchorTop(article: HTMLElement, element: HTMLElement, origin: number): number {
  return element.getBoundingClientRect().top - origin + article.scrollTop
}

export function scrollPreviewToSourceLine(article: HTMLElement, line: number): void {
  if (line <= 1) {
    article.scrollTop = 0
    return
  }
  const points = anchors(article)
  const origin = article.getBoundingClientRect().top
  const next = lowerBound(points.length, (index) => points[index]!.line >= line)
  const before = points[next - 1]
  const after = points[next]
  const beforeTop = before == null ? 0 : anchorTop(article, before.element, origin)
  article.scrollTop =
    after == null
      ? beforeTop
      : interpolate(
          line,
          before?.line ?? 1,
          after.line,
          beforeTop,
          anchorTop(article, after.element, origin),
        )
}

export function sourceLineAtPreviewTop(article: HTMLElement): number {
  if (article.scrollTop <= 0) return 1
  const points = anchors(article)
  const origin = article.getBoundingClientRect().top
  const next = lowerBound(
    points.length,
    (index) => anchorTop(article, points[index]!.element, origin) >= article.scrollTop,
  )
  const before = points[next - 1]
  const after = points[next]
  if (after == null) return before?.line ?? 1
  const beforeTop = before == null ? 0 : anchorTop(article, before.element, origin)
  const afterTop = anchorTop(article, after.element, origin)
  if (afterTop <= beforeTop) return after.line
  return Math.round(
    interpolate(article.scrollTop, beforeTop, afterTop, before?.line ?? 1, after.line),
  )
}

export function sourceLineAtEditorTop(scroller: HTMLElement): number | null {
  const root = scroller.querySelector('diffs-container')?.shadowRoot
  if (root == null) return null
  const top = scroller.getBoundingClientRect().top
  let closest: { line: number; distance: number } | null = null
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-line-index][data-line-type="context"]',
  )) {
    const rect = element.getBoundingClientRect()
    if (rect.height === 0 || rect.bottom < top) continue
    const distance = Math.abs(rect.top - top)
    if (closest == null || distance < closest.distance) {
      closest = { line: Number(element.dataset.lineIndex) + 1, distance }
    }
  }
  return closest?.line ?? null
}
