import { FileTree, type GitStatus, type GitStatusEntry } from '@pierre/trees'
import type { CommitFile } from './types'

const STATUS_BY_KIND: Partial<Record<CommitFile['kind'], GitStatus>> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
}

/**
 * Map commit file changes onto Pierre git status entries for display in a
 * FileTree. The tree shows directory structure and file decorations.
 */
function toGitStatus(files: CommitFile[]): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    const status = STATUS_BY_KIND[file.kind] ?? 'modified'
    entries.push({ path: file.path, status })
  }
  return entries
}

export interface CommitTreeCallbacks {
  onSelect(path: string | null): void
}

/**
 * Thin adapter over the Pierre Trees vanilla API for displaying commit file
 * changes in a tree structure. Directories start collapsed so the user can
 * drill down into the relevant paths.
 */
export class CommitFileTree {
  private readonly tree: FileTree
  private readonly callbacks: CommitTreeCallbacks

  constructor(mount: HTMLElement, callbacks: CommitTreeCallbacks) {
    this.callbacks = callbacks
    this.tree = new FileTree({
      paths: [],
      gitStatus: [],
      flattenEmptyDirectories: true,
      initialExpansion: 'closed',
      density: 'compact',
      onSelectionChange: (paths) => this.callbacks.onSelect(paths[0] ?? null),
    })
    this.tree.render({ containerWrapper: mount })
  }

  update(files: CommitFile[]): void {
    this.tree.resetPaths(files.map((f) => f.path))
    this.tree.setGitStatus(toGitStatus(files))
  }

  destroy(): void {
    this.tree.cleanUp()
  }
}
