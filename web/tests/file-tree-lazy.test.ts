import type { FileTree, FileTreeChildLoadAttempt } from '@pierre/trees'
import { describe, expect, it, vi } from 'vitest'

import {
  applyLazyDirectoryChildren,
  buildLazyPathReconciliationOperations,
  filterAlreadyAppliedLazyOperations,
  resolveFileTreeContextSelection,
  settleKnownEmptyDirectory,
} from '../src/diffshub/components/DiffsHubFileTree'

describe('FileTree multi-selection context menus', () => {
  it('preserves a right-click inside the selection and replaces it outside', () => {
    const selected = ['left.txt', 'right.txt']
    expect(resolveFileTreeContextSelection(selected, 'right.txt')).toBe(selected)
    expect(resolveFileTreeContextSelection(selected, 'outside.txt')).toEqual(['outside.txt'])
  })
})

describe('lazy FileTree child reconciliation', () => {
  it('emits deterministic minimal recursive removals and uncovered files', () => {
    const applied = new Set([
      'z.txt',
      'removed/child.txt',
      'kept.txt',
      'removed/',
      'removed/nested/',
      'a.txt',
    ])
    const next = new Set(['new-z.txt', 'kept.txt', 'new-a.txt'])

    expect(buildLazyPathReconciliationOperations(applied, next)).toEqual([
      { type: 'remove', path: 'a.txt', recursive: false },
      { type: 'remove', path: 'removed/', recursive: true },
      { type: 'remove', path: 'z.txt', recursive: false },
      { type: 'add', path: 'new-a.txt' },
      { type: 'add', path: 'new-z.txt' },
    ])
  })

  it('ignores operations already applied by Pierre drag and drop', () => {
    const existing = new Set(['kept.txt', 'already-added.txt'])
    expect(
      filterAlreadyAppliedLazyOperations(
        [
          { type: 'remove', path: 'already-moved.txt', recursive: false },
          { type: 'remove', path: 'kept.txt', recursive: false },
          { type: 'add', path: 'already-added.txt' },
          { type: 'add', path: 'new.txt' },
        ],
        (path) => existing.has(path),
      ),
    ).toEqual([
      { type: 'remove', path: 'kept.txt', recursive: false },
      { type: 'add', path: 'new.txt' },
    ])
  })

  it('bounds wide and deep reconciliation to minimal directory roots', () => {
    const applied = new Set<string>(['deep/'])
    let deepPath = 'deep/'
    for (let index = 0; index < 1_000; index += 1) {
      deepPath += `d${index}/`
      applied.add(deepPath)
      applied.add(`${deepPath}file.txt`)
    }
    for (let index = 0; index < 5_000; index += 1) {
      const directory = `wide-${index.toString().padStart(4, '0')}/`
      applied.add(directory)
      applied.add(`${directory}file.txt`)
    }

    const operations = buildLazyPathReconciliationOperations(applied, new Set())
    expect(operations).toHaveLength(5_001)
    expect(operations[0]).toEqual({ type: 'remove', path: 'deep/', recursive: true })
    expect(operations.at(-1)).toEqual({
      type: 'remove',
      path: 'wide-4999/',
      recursive: true,
    })
  })

  it('settles stale unloaded state for an authoritatively empty directory through Pierre', () => {
    const attempt = { attemptId: 3, nodeId: 7, reused: false } satisfies FileTreeChildLoadAttempt
    const beginChildLoad = vi.fn(() => attempt)
    const applyChildPatch = vi.fn(() => true)
    const completeChildLoad = vi.fn(() => true)
    const getDirectoryLoadState = vi.fn(() => 'unloaded')
    const model = {
      getItem: vi.fn(() => ({ isDirectory: () => true })),
      getDirectoryLoadState,
      beginChildLoad,
      applyChildPatch,
      completeChildLoad,
    } as unknown as FileTree

    expect(settleKnownEmptyDirectory(model, 'empty/')).toBe(true)
    expect(beginChildLoad).toHaveBeenCalledWith('empty/')
    expect(applyChildPatch).toHaveBeenCalledWith(attempt, { operations: [] })
    expect(completeChildLoad).toHaveBeenCalledWith(attempt)

    getDirectoryLoadState.mockReturnValue('loaded')
    expect(settleKnownEmptyDirectory(model, 'loaded/')).toBe(false)
    expect(beginChildLoad).toHaveBeenCalledTimes(1)
  })

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
