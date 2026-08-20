import { describe, expect, it } from 'vitest'
import { reviewFileCount, reviewIdentityKey, reviewToItems } from '../src/lib/review-data'
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

  it('counts tracked and supplemental files without eager per-file requests', () => {
    expect(reviewFileCount(review())).toBe(3)
    expect(reviewIdentityKey({ scope: 'compare', from: 'main', to: 'topic' })).toBe(
      'compare::main:topic',
    )
  })
})
