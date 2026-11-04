import { describe, expect, it } from 'vite-plus/test'
import { reviewFileCount, reviewIdentityKey, reviewToItems } from '../src/lib/review-data'
import { adaptGitnaReview } from '../src/diffshub/gitna/reviewAdapter'
import { buildDiffsHubData } from '../src/diffshub/lib/diffsHubDataAccumulator'
import type { ReviewResponse } from '../src/lib/types'

const patch = `diff --git a/a.txt b/a.txt
index df967b9..3e75765 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-base
+changed
`

function review(): ReviewResponse {
  return {
    generation: 7,
    identity: { scope: 'unstaged' },
    patch,
    supplements: [
      {
        path: 'new.txt',
        kind: 'untracked',
        diff: {
          before: { path: 'new.txt', content: '' },
          after: { path: 'new.txt', content: 'new\n', language: 'text' },
          binary: false,
          tooLarge: false,
        },
      },
      {
        path: 'large.dat',
        kind: 'untracked',
        diff: {
          before: { path: 'large.dat', content: '' },
          after: { path: 'large.dat', content: '' },
          binary: false,
          tooLarge: true,
        },
      },
    ],
  }
}

describe('review data', () => {
  it('creates stable multi-file CodeView items and path identities', () => {
    const first = reviewToItems(review())
    const second = reviewToItems(review())
    expect(first.items).toHaveLength(3)
    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id))
    expect(first.pathToItemId.get('a.txt')).toBe(first.items[0]?.id)
    expect(first.pathToItemId.get('new.txt')).toBe(first.items[1]?.id)
    expect(first.statusByItemId.get(first.items[2]!.id)).toBe('too-large')
  })

  it('retains stable, isolated worker cache keys for parsed patches', () => {
    const adapters = [
      (owner: string) => {
        const input = review()
        input.identity = { scope: 'commit', commit: owner }
        return reviewToItems(input)
      },
      (owner: string) => adaptGitnaReview(review(), owner),
      (owner: string) => buildDiffsHubData(patch, owner),
    ]
    for (const adapt of adapters) {
      const key = (owner: string) => {
        const item = adapt(owner).items[0]
        if (item?.type !== 'diff') throw new Error('Expected a parsed diff')
        return item.fileDiff.cacheKey
      }
      expect(key('first')).toBeDefined()
      expect(key('first')).toBe(key('first'))
      expect(key('first')).not.toBe(key('second'))
    }
  })

  it('preserves Git change blocks instead of realigning similar source lines', () => {
    const input = review()
    input.patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
-export const alpha = 1;
-export const beta = 2;
-export const gamma = 3;
+// inserted heading
+export const alpha = 10;
+export const beta = 20;
+export const gamma = 30;
`
    for (const result of [reviewToItems(input), adaptGitnaReview(input)]) {
      const item = result.items[0]
      if (item?.type !== 'diff') throw new Error('Expected a parsed diff')
      expect(item.fileDiff.hunks[0]?.hunkContent).toEqual([
        {
          type: 'change',
          additions: 4,
          deletions: 3,
          additionLineIndex: 0,
          deletionLineIndex: 0,
        },
      ])
    }
  })

  it('counts tracked and supplemental files without eager per-file requests', () => {
    expect(reviewFileCount(review())).toBe(3)
    expect(reviewIdentityKey({ scope: 'compare', from: 'main', to: 'topic' })).toBe(
      'compare::main:topic',
    )
  })
})
