import type { FileTree, FileTreeChildLoadAttempt } from '@pierre/trees'
import { describe, expect, it, vi } from 'vitest'

import { applyLazyDirectoryChildren } from '../src/diffshub/components/DiffsHubFileTree'

describe('lazy FileTree child reconciliation', () => {
  it('does not mutate applied paths when a stale child attempt resolves after its replacement', () => {
    const newer = { attemptId: 2, nodeId: 1, reused: false } satisfies FileTreeChildLoadAttempt
    const stale = { attemptId: 1, nodeId: 1, reused: false } satisfies FileTreeChildLoadAttempt
    const applyChildPatch = vi.fn((attempt: FileTreeChildLoadAttempt) => attempt.attemptId === 2)
    const model = { applyChildPatch } as unknown as FileTree
    const applied = new Set(['dir/', 'dir/old.txt'])

    expect(applyLazyDirectoryChildren(model, newer, 'dir/', ['dir/new.txt'], applied)).toBe(true)
    expect(applied).toEqual(new Set(['dir/', 'dir/new.txt']))

    expect(applyLazyDirectoryChildren(model, stale, 'dir/', ['dir/old.txt'], applied)).toBe(false)
    expect(applied).toEqual(new Set(['dir/', 'dir/new.txt']))
    expect(applyChildPatch).toHaveBeenCalledTimes(2)
  })
})
