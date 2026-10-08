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
  it('traverses newly exposed descendants even when their directory loads are cached', async () => {
    const expanded = new Set<string>()
    let listener: (() => void) | undefined
    const unsubscribe = vi.fn(() => {
      listener = undefined
    })
    const visibleRows = () => [
      { kind: 'directory', path: 'nested/' },
      ...(expanded.has('nested/') ? [{ kind: 'directory', path: 'nested/deeper/' }] : []),
      ...(expanded.has('nested/deeper/') ? [{ kind: 'file', path: 'nested/deeper/file.txt' }] : []),
    ]
    const model = {
      subscribe: (callback: () => void) => {
        listener = callback
        return unsubscribe
      },
      getVisibleCount: () => visibleRows().length,
      getVisibleRows: visibleRows,
      getDirectoryLoadState: () => 'loaded',
      getItem: (path: string) => ({
        isDirectory: () => true,
        isExpanded: () => expanded.has(path),
        expand: () => {
          expanded.add(path)
          listener?.()
        },
      }),
    } as unknown as FileTree
    expandRepositoryFolders(model)
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
    expect(expanded).toEqual(new Set(['nested/', 'nested/deeper/']))
    expect(visibleRows()).toContainEqual({ kind: 'file', path: 'nested/deeper/file.txt' })
  })

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
