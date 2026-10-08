import type { FileTree } from '@pierre/trees'
import { describe, expect, it, vi } from 'vite-plus/test'

import { expandRepositoryFolders } from '../src/diffshub/gitna/expandRepositoryFolders'

function pendingTree() {
  let expanded = false
  let state: 'loading' | 'loaded' | 'error' = 'loading'
  let listener: (() => void) | undefined
  const expand = vi.fn(() => {
    expanded = true
  })
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const item = { isDirectory: () => true, isExpanded: () => expanded, expand }
  const model = {
    subscribe: (callback: () => void) => {
      listener = callback
      return unsubscribe
    },
    getVisibleCount: () => 1,
    getVisibleRows: () => [{ kind: 'directory', path: 'nested/' }],
    getItem: () => item,
    getDirectoryLoadState: () => state,
  } as unknown as FileTree
  return {
    model,
    expand,
    unsubscribe,
    settle(next: typeof state) {
      state = next
      listener?.()
    },
    collapse() {
      expanded = false
      listener?.()
    },
  }
}

describe('Expand all lifecycle', () => {
  it('unsubscribes on directory failure and does not retry on later notifications', async () => {
    const tree = pendingTree()
    expandRepositoryFolders(tree.model)
    await Promise.resolve()
    expect(tree.expand).toHaveBeenCalledTimes(1)
    tree.settle('error')
    await Promise.resolve()
    expect(tree.unsubscribe).toHaveBeenCalledTimes(1)
    tree.settle('loaded')
    await Promise.resolve()
    expect(tree.expand).toHaveBeenCalledTimes(1)
  })

  it('ignores late responses after explicit cancellation', async () => {
    const tree = pendingTree()
    const cancel = expandRepositoryFolders(tree.model)
    await Promise.resolve()
    cancel()
    tree.collapse()
    tree.settle('loaded')
    await Promise.resolve()
    expect(tree.unsubscribe).toHaveBeenCalledTimes(1)
    expect(tree.expand).toHaveBeenCalledTimes(1)
  })

  it('cancels when a user collapses a pending expanded directory', async () => {
    const tree = pendingTree()
    expandRepositoryFolders(tree.model)
    await Promise.resolve()
    tree.collapse()
    await Promise.resolve()
    expect(tree.unsubscribe).toHaveBeenCalledTimes(1)
    tree.settle('loaded')
    await Promise.resolve()
    expect(tree.expand).toHaveBeenCalledTimes(1)
  })
})
