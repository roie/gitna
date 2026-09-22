// Match rendered Markdown blocks to source lines; the two panes have different heights.
function anchors(article: HTMLElement): { line: number; top: number }[] {
  const origin = article.getBoundingClientRect().top
  const result: { line: number; top: number }[] = [{ line: 1, top: 0 }]
  for (const element of article.querySelectorAll<HTMLElement>('[data-source-line]')) {
    const line = Number(element.dataset.sourceLine)
    const top = element.getBoundingClientRect().top - origin + article.scrollTop
    const last = result.at(-1)
    if (last != null && line > last.line && top > last.top) {
      result.push({ line, top })
    }
  }
  return result
}

function interpolate(value: number, from: number, to: number, start: number, end: number): number {
  return start + ((value - from) / (to - from)) * (end - start)
}

export function scrollPreviewToSourceLine(article: HTMLElement, line: number): void {
  const points = anchors(article)
  const next = points.findIndex((point) => point.line >= line)
  if (next === 0) {
    article.scrollTop = 0
  } else if (next > 0) {
    const before = points[next - 1]
    const after = points[next]
    if (before != null && after != null) {
      article.scrollTop = interpolate(line, before.line, after.line, before.top, after.top)
    }
  } else {
    article.scrollTop = points.at(-1)?.top ?? 0
  }
}

export function sourceLineAtPreviewTop(article: HTMLElement): number {
  const points = anchors(article)
  const next = points.findIndex((point) => point.top >= article.scrollTop)
  if (next < 0) return points.at(-1)?.line ?? 1
  if (next === 0) return points[0]?.line ?? 1
  const before = points[next - 1]
  const after = points[next]
  if (before == null || after == null) return 1
  return Math.round(interpolate(article.scrollTop, before.top, after.top, before.line, after.line))
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
