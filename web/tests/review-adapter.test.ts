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
  it('parses the supplied Git hunk and preserves complete context and canonical paths', () => {
    const path = 'Q3 — FINAL.md'
    const input = page(path)
    input.supplements[0]!.kind = 'modified'
    input.supplements[0]!.diff.before.content = 'same\nsame\nsame\n'
    input.supplements[0]!.diff.after.content = 'same\nsame\n'
    input.supplements[0]!.diff.patch =
      'diff --git a/escaped.md b/escaped.md\n--- a/escaped.md\n+++ b/escaped.md\n@@ -3 +2,0 @@\n-same\n'
    const result = appendGitnaReviewPage(createGitnaReviewAccumulator(input), input)
    const item = result.data.items[0]
    expect(item?.type).toBe('diff')
    if (item?.type !== 'diff') throw new Error('Expected a diff')
    expect(item.fileDiff.name).toBe(path)
    expect(item.fileDiff.isPartial).toBe(false)
    expect(item.fileDiff.deletionLines).toHaveLength(3)
    expect(item.fileDiff.additionLines).toHaveLength(2)
    expect(item.fileDiff.hunks[0]?.deletionStart).toBe(3)
    expect(result.data.treeSource.paths).toEqual([path])
  })

  it.each(['binary', 'tooLarge'] as const)('explains omitted %s previews', (flag) => {
    const input = page('generated.dat')
    input.supplements[0]!.kind = 'modified'
    input.supplements[0]!.diff.after.content = ''
    input.supplements[0]!.diff[flag] = true
    const result = appendGitnaReviewPage(createGitnaReviewAccumulator(input), input)
    expect(result.data.items[0]?.annotations?.[0]?.metadata).toMatchObject({
      kind: 'preview',
      message: flag === 'binary' ? 'Binary file changed' : 'Too large to preview',
    })
  })

  it('keeps canonical unicode paths for content-derived untracked files', () => {
    const path = 'Q3 — FINAL.md'
    const input = page(path)
    const result = appendGitnaReviewPage(createGitnaReviewAccumulator(input), input)
    const item = result.data.items[0]
    if (item?.type !== 'diff') throw new Error('Expected a diff')
    expect(item.fileDiff.name).toBe(path)
    expect(result.data.treeSource.paths).toEqual([path])
  })

  it('appends pages with stable unique item ids and a shared viewer version', () => {
    const first = page('a.txt', 7, 'next')
    const assembly = createGitnaReviewAccumulator(first, 42)
    const firstResult = appendGitnaReviewPage(assembly, first)
    const secondResult = appendGitnaReviewPage(assembly, page('b.txt'))

    expect(firstResult.pendingItems.map((item) => item.id)).toEqual(['a.txt'])
    expect(secondResult.pendingItems.map((item) => item.id)).toEqual(['b.txt'])
    expect(secondResult.data.items.map((item) => item.id)).toEqual(['a.txt', 'b.txt'])
    expect(secondResult.data.items.map((item) => item.version)).toEqual([42, 42])
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
