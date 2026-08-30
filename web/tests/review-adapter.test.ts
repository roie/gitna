import { describe, expect, it } from 'vitest'
import {
  adaptWorktreeComparison,
  appendGitnaReviewPage,
  createGitnaReviewAccumulator,
} from '../src/diffshub/gitna/reviewAdapter'
import type { ReviewResponse } from '../src/lib/types'

function page(path: string, generation = 7, nextCursor?: string): ReviewResponse {
  return {
    generation,
    identity: { scope: 'unstaged' },
    patch: '',
    supplements: [
      {
        path,
        kind: 'untracked',
        diff: {
          before: { path, content: '', language: 'text' },
          after: { path, content: `${path}\n`, language: 'text' },
          binary: false,
          tooLarge: false,
        },
      },
    ],
    nextCursor,
  }
}

describe('worktree comparison adapter', () => {
  it('uses dirty draft contents and image annotations in Pierre diff items', () => {
    const text = adaptWorktreeComparison(
      {
        before: { path: 'left.txt', content: 'left\n', language: 'text' },
        after: { path: 'right.txt', content: 'right\n', language: 'text' },
        binary: false,
        tooLarge: false,
      },
      3,
      { name: 'left.txt', contents: 'dirty left\n' },
    )
    expect(text.items).toHaveLength(1)
    expect(text.items[0]?.type).toBe('diff')
    if (text.items[0]?.type === 'diff') {
      expect(text.items[0].fileDiff.deletionLines).toContain('dirty left\n')
      expect(text.items[0].fileDiff.additionLines).toContain('right\n')
    }

    const image = adaptWorktreeComparison(
      {
        before: {
          path: 'left.png',
          content: '',
          image: { mime: 'image/png', data: 'bGVmdA==', size: 4 },
        },
        after: {
          path: 'right.png',
          content: '',
          image: { mime: 'image/png', data: 'cmlnaHQ=', size: 5 },
        },
        binary: true,
        tooLarge: false,
      },
      3,
    )
    expect(image.items[0]?.annotations).toHaveLength(2)
  })
})

describe('paged Gitna review adapter', () => {
  it('appends pages with stable unique item ids', () => {
    const first = page('a.txt', 7, 'next')
    const assembly = createGitnaReviewAccumulator(first)
    const firstResult = appendGitnaReviewPage(assembly, first)
    const secondResult = appendGitnaReviewPage(assembly, page('b.txt'))

    expect(firstResult.pendingItems.map((item) => item.id)).toEqual(['a.txt'])
    expect(secondResult.pendingItems.map((item) => item.id)).toEqual(['b.txt'])
    expect(secondResult.data.items.map((item) => item.id)).toEqual(['a.txt', 'b.txt'])
    expect(secondResult.data.treeSource.paths).toEqual(['a.txt', 'b.txt'])
  })

  it('rejects pages from a different repository generation', () => {
    const first = page('a.txt')
    const assembly = createGitnaReviewAccumulator(first)
    appendGitnaReviewPage(assembly, first)

    expect(() => appendGitnaReviewPage(assembly, page('b.txt', 8))).toThrow(
      'Review changed while additional files were loading',
    )
  })
})
