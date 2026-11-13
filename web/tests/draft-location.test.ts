import type { CodeViewItem, LineAnnotation } from '@pierre/diffs'
import { describe, expect, it } from 'vite-plus/test'

import { relocateDraft } from '../src/diffshub/lib/draftLocation'
import type { CommentMetadata, DraftCommentMetadata } from '../src/diffshub/lib/types'

function file(contents: string): CodeViewItem<CommentMetadata> {
  return {
    type: 'file',
    id: 'a.txt',
    file: { name: 'a.txt', contents },
  } as CodeViewItem<CommentMetadata>
}

function draft(start: number, end: number, code: string): LineAnnotation<DraftCommentMetadata> {
  return {
    lineNumber: end,
    metadata: {
      kind: 'draft',
      key: 'draft-1',
      message: 'typed',
      range: { start, end },
      code,
      anchor: {
        source: 'worktree',
        path: 'a.txt',
        view: 'file',
        side: 'additions',
        startLine: start,
        endLine: end,
        code,
      },
    },
  }
}

describe('relocateDraft', () => {
  it('stays where its lines still hold its code', () => {
    const annotation = draft(2, 3, 'b\nc')
    expect(relocateDraft(file('a\nb\nc\nd'), annotation)).toBe(annotation)
  })

  it('follows its code to the only other place that holds it', () => {
    const moved = relocateDraft(file('new\nnew\na\nb\nc\nd'), draft(2, 3, 'b\nc'))
    expect(moved.lineNumber).toBe(5)
    expect(moved.metadata).toMatchObject({
      range: { start: 4, end: 5 },
      outdated: false,
      message: 'typed',
    })
  })

  it('is outdated, not attached to other code, when its code changed or is ambiguous', () => {
    const changed = relocateDraft(file('a\nB\nc'), draft(2, 3, 'b\nc'))
    expect(changed.metadata).toMatchObject({ outdated: true, range: { start: 2, end: 3 } })

    const twice = relocateDraft(file('x\nb\ny\nb'), draft(1, 1, 'b'))
    expect(twice.metadata.outdated).toBe(true)

    const shorter = relocateDraft(file('a\nz'), draft(4, 4, 'd'))
    expect(shorter).toMatchObject({ lineNumber: 2, metadata: { outdated: true } })
  })

  it('is current again once its code is back on its lines', () => {
    const outdated = relocateDraft(file('a'), draft(2, 2, 'b'))
    expect(outdated.lineNumber).toBe(1)
    expect(relocateDraft(file('a\nb\nc'), outdated)).toMatchObject({
      lineNumber: 2,
      metadata: { outdated: false },
    })
  })
})
