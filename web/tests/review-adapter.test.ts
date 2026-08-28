import { describe, expect, it } from 'vitest'
import {
  adaptGitnaFile,
  appendGitnaReviewPage,
  createGitnaReviewAccumulator,
} from '../src/diffshub/gitna/reviewAdapter'
import type { FileDiff, ReviewResponse } from '../src/lib/types'

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

describe('paged Gitna review adapter', () => {
  it('gives successive historical versions distinct Pierre identities', () => {
    const historical = (content: string): FileDiff => ({
      before: { path: 'src/main.ts', content: '', language: 'typescript' },
      after: { path: 'src/main.ts', content, language: 'typescript' },
      binary: false,
      tooLarge: false,
    })
    const first = adaptGitnaFile(historical('first\n'), 7, {
      key: 'first:after:src/main.ts',
      revision: 1,
    })
    const second = adaptGitnaFile(historical('second\n'), 7, {
      key: 'second:after:src/main.ts',
      revision: 2,
    })

    expect(first.items[0]).toMatchObject({
      id: 'historical:first:after:src/main.ts',
      version: -1,
    })
    expect(second.items[0]).toMatchObject({
      id: 'historical:second:after:src/main.ts',
      version: -2,
    })
    expect(first.items[0]?.type === 'file' && first.items[0].file.cacheKey).not.toBe(
      second.items[0]?.type === 'file' && second.items[0].file.cacheKey,
    )
    expect(second.items[0]?.type === 'file' && second.items[0].file.contents).toBe('second\n')
  })

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
