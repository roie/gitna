import { describe, expect, it } from 'vitest'
import {
  scrollPreviewToSourceLine,
  sourceLineAtPreviewTop,
} from '../src/diffshub/gitna/markdownScroll'

function preview(blocks: { line: number; top: number }[], scrollTop = 0) {
  let measurements = 0
  const article = {
    scrollTop,
    getBoundingClientRect: () => ({ top: 40 }),
    querySelectorAll: () =>
      blocks.map(({ line, top }) => ({
        dataset: { sourceLine: `${line}` },
        getBoundingClientRect: () => {
          measurements += 1
          return { top: 40 + top - article.scrollTop }
        },
      })),
  }
  return { article: article as unknown as HTMLElement, measurements: () => measurements }
}

describe('Markdown scroll synchronization', () => {
  it('interpolates source and preview positions and clamps at document boundaries', () => {
    const { article } = preview([
      { line: 11, top: 100 },
      { line: 21, top: 300 },
    ])
    scrollPreviewToSourceLine(article, 16)
    expect(article.scrollTop).toBe(200)
    expect(sourceLineAtPreviewTop(article)).toBe(16)
    scrollPreviewToSourceLine(article, 6)
    expect(article.scrollTop).toBe(50)
    expect(sourceLineAtPreviewTop(article)).toBe(6)
    scrollPreviewToSourceLine(article, 50)
    expect(article.scrollTop).toBe(300)
    article.scrollTop = 400
    expect(sourceLineAtPreviewTop(article)).toBe(21)
    scrollPreviewToSourceLine(article, 1)
    expect(article.scrollTop).toBe(0)
    expect(sourceLineAtPreviewTop(article)).toBe(1)
  })

  it('handles duplicate source positions in nested blocks and empty previews', () => {
    const { article } = preview(
      [
        { line: 11, top: 100 },
        { line: 11, top: 100 },
        { line: 21, top: 300 },
      ],
      200,
    )
    expect(sourceLineAtPreviewTop(article)).toBe(16)
    const empty = preview([], 100).article
    expect(sourceLineAtPreviewTop(empty)).toBe(1)
    scrollPreviewToSourceLine(empty, 20)
    expect(empty.scrollTop).toBe(0)
  })

  it('does not lay out the whole document to synchronize a long preview', () => {
    const { article, measurements } = preview(
      Array.from({ length: 1000 }, (_, i) => ({ line: 2 + i * 3, top: 50 + i * 100 })),
    )
    scrollPreviewToSourceLine(article, 1503)
    expect(measurements()).toBeLessThanOrEqual(2)
    expect(sourceLineAtPreviewTop(article)).toBe(1503)
    expect(measurements()).toBeLessThan(16)
  })
})
