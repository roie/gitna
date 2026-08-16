import { FileTree, type GitStatus, type GitStatusEntry } from '@pierre/trees'
import type { ChangeScope, FileChange } from './types'
import type { Selection } from './repo-state.svelte'

const STATUS_BY_KIND: Partial<Record<FileChange['kind'], GitStatus>> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
  ignored: 'ignored',
}

/**
 * Map our normalized changes onto Pierre git status entries. A conflicted file
 * keeps its closest Git status (usually modified) so it renders with the
 * regular decoration lane; the conflict is surfaced separately through a row
 * decoration.
 */
export function toGitStatus(changes: FileChange[]): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  const seen = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.path)) continue
    seen.add(change.path)
    const status = STATUS_BY_KIND[change.kind] ?? 'modified'
    entries.push({ path: change.path, status })
  }
  return entries
}

export interface ChangeTreeCallbacks {
  onSelect(scope: ChangeScope, path: string | null): void
}

/**
 * Thin adapter over the Pierre Trees vanilla API. The tree owns path display,
 * expansion, and selection; application logic (which change is selected) stays
 * in RepoState. Selection updates flow upward through `onSelect`.
 */
export class ChangeTree {
  readonly scope: ChangeScope

  private readonly tree: FileTree
  private readonly callbacks: ChangeTreeCallbacks
  private conflictedPaths = new Set<string>()

  constructor(
    mount: HTMLElement,
    scope: ChangeScope,
    callbacks: ChangeTreeCallbacks,
  ) {
    this.scope = scope
    this.callbacks = callbacks
    this.tree = new FileTree({
      paths: [],
      gitStatus: [],
      flattenEmptyDirectories: true,
      initialExpansion: 'open',
      density: 'compact',
      onSelectionChange: (paths) => this.callbacks.onSelect(this.scope, paths[0] ?? null),
      renderRowDecoration: (context) =>
        this.conflictedPaths.has(context.item.path) ? { text: 'conflict' } : null,
    })
    this.tree.render({ containerWrapper: mount })
  }

  update(changes: FileChange[], selection: Selection | null): void {
    this.conflictedPaths = new Set(changes.filter((c) => c.conflicted).map((c) => c.path))
    this.tree.resetPaths(changes.map((c) => c.path))
    this.tree.setGitStatus(toGitStatus(changes))

    const ownsSelection = selection != null && selection.scope === this.scope
    if (ownsSelection) {
      const selected = this.tree.getItem(selection.change.path)
      if (selected != null) {
        if (!selected.isSelected()) selected.select()
      } else {
        const nearest = this.tree.focusNearestPath(selection.change.path)
        const item = nearest != null ? this.tree.getItem(nearest) : null
        if (item != null && !item.isSelected()) item.select()
      }
    } else {
      for (const path of this.tree.getSelectedPaths()) {
        this.tree.getItem(path)?.deselect()
      }
    }
  }

  destroy(): void {
    this.tree.cleanUp()
  }
}
