import { createApi, type ApiClient, type MutateRequest } from './api'
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
 * Coalesces bursts of trigger() calls into a single invocation of refresh
 * after a quiet period. Event streams (SSE) can fire in clusters; only the
 * most recent state matters once the burst settles.
 */
export function coalesce(refresh: () => void, delay = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  return () => {
    if (pending) return
    pending = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      pending = false
      refresh()
    }, delay)
  }
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
  let mutationError = $state<string | null>(null)
  let busy = $state(false)
  let generation = $state(0)
  let selection = $state<Selection | null>(null)

  let refreshRunning = false
  let refreshAgain = false

  async function refreshSnapshot(): Promise<void> {
    if (refreshRunning) {
      refreshAgain = true
      return
    }
    refreshRunning = true
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
      refreshRunning = false
      if (refreshAgain) {
        refreshAgain = false
        void refreshSnapshot()
      }
    }
  }

  const scheduleRefresh = coalesce(() => void refreshSnapshot())

  let eventSource: EventSource | null = null

  /**
   * Subscribes to the server's invalidation stream and refreshes the snapshot
   * after bursts settle. EventSource reconnects automatically after transient
   * disconnections; the returned cleanup closes the connection.
   */
  function connectEvents(): () => void {
    if (eventSource) return () => {}
    const source = new EventSource('api/v1/events')
    eventSource = source
    source.addEventListener('snapshot-invalidated', () => scheduleRefresh())
    return () => {
      source.close()
      if (eventSource === source) eventSource = null
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

  /**
   * Applies a repository mutation, then refreshes the snapshot so the index
   * and worktree views reflect the change. Failures are recorded in
   * mutationError (which the follow-up snapshot refresh leaves untouched), and
   * the rejection propagates to the caller.
   */
  async function mutate(request: MutateRequest): Promise<void> {
    busy = true
    try {
      await api.mutate(request)
      mutationError = null
    } catch (e) {
      mutationError = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      busy = false
      void refreshSnapshot()
    }
  }

  /**
   * Commits the staged changes with the given message, or amends HEAD. Git
   * hooks run normally: a rejected commit surfaces through mutationError while
   * the rejection propagates so the composer can keep the user's text.
   */
  async function commit(message: string, amend = false): Promise<void> {
    busy = true
    try {
      const result = await api.commit({ message, amend })
      if (!result.ok) {
        const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
        const why = detail || `commit failed (exit ${result.exitCode ?? 1})`
        mutationError = why
        throw new Error(why)
      }
      mutationError = null
    } catch (e) {
      mutationError ??= e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      busy = false
      void refreshSnapshot()
    }
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
    get mutationError() {
      return mutationError
    },
    get busy() {
      return busy
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
    connectEvents,
    select,
    mutate,
    commit,
  }
}

export type RepoState = ReturnType<typeof createRepoState>
