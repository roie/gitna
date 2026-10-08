import type { FileTree, FileTreeDirectoryHandle } from '@pierre/trees'

export function expandRepositoryFolders(model: FileTree): () => void {
  let canceled = false
  let queued = false
  const expanded = new Set<string>()
  const schedule = () => {
    if (canceled || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (canceled) return
      for (const path of expanded) {
        const item = model.getItem(path)
        if (item?.isDirectory() && !(item as FileTreeDirectoryHandle).isExpanded()) {
          cancel()
          return
        }
      }
      for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
        if (row.kind !== 'directory') continue
        const item = model.getItem(row.path) as FileTreeDirectoryHandle | null
        if (item == null) continue
        expanded.add(row.path)
        if (!item.isExpanded()) item.expand()
      }
      const pending = Array.from(expanded).some((path) => {
        const state = model.getDirectoryLoadState(path)
        return state === 'unloaded' || state === 'loading'
      })
      if (!pending) cancel()
    })
  }
  const unsubscribe = model.subscribe(schedule)
  const cancel = () => {
    canceled = true
    unsubscribe()
  }
  schedule()
  return cancel
}
