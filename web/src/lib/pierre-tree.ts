import { FileTree, type GitStatus, type GitStatusEntry } from '@pierre/trees'
import type { ChangeScope, FileChange } from './types'
import type { Selection } from './repo-state.svelte'

// Layout and search behavior adapted from Pierre DiffsHub DiffsHubFileTree.tsx
// and constants.ts at diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
// Ported from React to the vanilla Trees API. Apache-2.0; Copyright 2025
// Pierre Computer Company.
const TREE_CSS = `
  [data-file-tree-search-container][data-open='false'] { display: none; }
  [data-file-tree-search-container] {
    margin: 0 6px 6px;
    padding: 0 0 6px;
    border-bottom: 1px solid var(--color-border);
  }
  [data-file-tree-virtualized-scroll='true'] { padding-inline: 0 2px; }
  [data-item-contains-git-change='true'] > [data-item-section='git'] { display: none; }
  [data-item-type='folder'] { font-weight: 500; }
  [data-file-tree-sticky-overlay-content] { box-shadow: 0 3px 3px -4px rgb(0 0 0 / .8); }
`

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

  constructor(mount: HTMLElement, scope: ChangeScope, callbacks: ChangeTreeCallbacks) {
    this.scope = scope
    this.callbacks = callbacks
    this.tree = new FileTree({
      paths: [],
      gitStatus: [],
      id: `gitna-${scope}-tree`,
      flattenEmptyDirectories: true,
      initialExpansion: 'open',
      density: 0.8,
      search: true,
      searchBlurBehavior: 'retain',
      stickyFolders: true,
      unsafeCSS: TREE_CSS,
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
      if (selected == null) {
        const nearest = this.tree.focusNearestPath(selection.change.path)
        const item = nearest == null ? null : this.tree.getItem(nearest)
        if (item != null && !item.isSelected()) item.select()
      } else if (!selected.isSelected()) selected.select()
    } else {
      for (const path of this.tree.getSelectedPaths()) {
        this.tree.getItem(path)?.deselect()
      }
    }
  }

  setSearchOpen(open: boolean): void {
    if (open === this.tree.isSearchOpen()) return
    if (open) this.tree.openSearch()
    else this.tree.closeSearch()
  }

  destroy(): void {
    this.tree.cleanUp()
  }
}
