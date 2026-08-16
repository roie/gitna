import { createApi, type ApiClient } from './api'
import type { ChangeScope, FileChange, RepoSnapshot } from './types'

export interface Selection {
  scope: ChangeScope
  change: FileChange
}

export interface RepoStateOptions {
  api?: ApiClient
}

function changesIn(snap: RepoSnapshot, scope: ChangeScope): FileChange[] {
  return scope === 'staged' ? snap.staged : snap.unstaged
}

/**
 * Pure, deterministic selection reconciliation used after every snapshot
 * refresh. Keeps the selection when the path still exists; otherwise selects
 * the nearest remaining changed file by list order (immediate successor, else
 * the last entry) or clears the selection when no changes remain.
 */
export function reconcileSelection(
  selection: Selection | null,
  staged: FileChange[],
  unstaged: FileChange[],
): Selection | null {
  if (!selection) return selection
  const list = selection.scope === 'staged' ? staged : unstaged
  const existing = list.find((c) => c.path === selection.change.path)
  if (existing) return { scope: selection.scope, change: existing }
  const ordered = [...staged, ...unstaged]
  const nearest = ordered.find((c) => c.path >= selection.change.path) ?? ordered[ordered.length - 1]
  if (!nearest) return null
  return { scope: nearest.scope, change: nearest }
}

/**
 * Application state for the Source Control view. The server snapshot is the
 * single source of truth; component-local state never duplicates Git semantics.
 */
export function createRepoState(options: RepoStateOptions = {}) {
  const api = options.api ?? createApi()

  let snapshot = $state<RepoSnapshot | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let generation = $state(0)
  let selection = $state<Selection | null>(null)

  async function refreshSnapshot(): Promise<void> {
    loading = true
    error = null
    try {
      const snap = await api.snapshot()
      if (snap.generation <= generation) return
      generation = snap.generation
      snapshot = snap
      selection = reconcileSelection(selection, snap.staged, snap.unstaged)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  function select(scope: ChangeScope, path: string | null): void {
    if (!snapshot) return
    if (path == null) {
      selection = null
      return
    }
    const change = changesIn(snapshot, scope).find((c) => c.path === path)
    if (change) selection = { scope, change }
  }

  return {
    get api() {
      return api
    },
    get snapshot() {
      return snapshot
    },
    get loading() {
      return loading
    },
    get error() {
      return error
    },
    get generation() {
      return generation
    },
    get selection() {
      return selection
    },
    get selectedChange() {
      return selection?.change ?? null
    },
    refreshSnapshot,
    select,
  }
}

export type RepoState = ReturnType<typeof createRepoState>
