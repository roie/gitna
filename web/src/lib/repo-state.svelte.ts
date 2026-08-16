import { createApi, type ApiClient, type MutateRequest } from './api'
import { computeGraph } from './graph-lanes'
import type {
  ChangeKind,
  ChangeScope,
  CommitFile,
  FileChange,
  GraphCommit,
  RepoSnapshot,
} from './types'

export interface Selection {
  scope: ChangeScope
  change: FileChange
}

/** A file changed by a commit, selected for display in the diff pane. */
export interface CommitDiffTarget {
  oid: string
  subject: string
  path: string
  oldPath?: string
  kind: ChangeKind
}

export interface RepoStateOptions {
  api?: ApiClient
}

function omit<V>(obj: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _removed, ...rest } = obj
  return rest
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

  let graphCommits = $state<GraphCommit[]>([])
  let graphLoading = $state(false)
  let graphError = $state<string | null>(null)
  let graphHasMore = $state(false)
  let expanded = $state<Record<string, boolean>>({})
  let commitFiles = $state<Record<string, CommitFile[]>>({})
  let filesLoading = $state<Record<string, boolean>>({})
  let filesError = $state<Record<string, string>>({})
  let commitDiff = $state<CommitDiffTarget | null>(null)

  const graphRows = $derived(computeGraph(graphCommits))

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

  /**
   * Replaces the graph with the first page of history. Expanded commits that
   * no longer exist (e.g. after an amend) are collapsed and their cached files
   * are dropped, so the graph never references commits it cannot render.
   */
  async function refreshGraph(): Promise<void> {
    graphLoading = true
    graphError = null
    try {
      const page = await api.graph(0)
      graphCommits = page.commits
      graphHasMore = page.hasMore
      const present = new Set(page.commits.map((c) => c.oid))
      const nextExpanded: Record<string, boolean> = {}
      for (const [oid, open] of Object.entries(expanded)) {
        if (open && present.has(oid)) nextExpanded[oid] = true
      }
      expanded = nextExpanded
      const nextFiles: Record<string, CommitFile[]> = {}
      for (const [oid, files] of Object.entries(commitFiles)) {
        if (present.has(oid)) nextFiles[oid] = files
      }
      commitFiles = nextFiles
    } catch (e) {
      graphError = e instanceof Error ? e.message : String(e)
    } finally {
      graphLoading = false
    }
  }

  /** Appends the next page of history to the loaded graph. */
  async function loadMoreGraph(): Promise<void> {
    graphLoading = true
    try {
      const page = await api.graph(graphCommits.length)
      const seen = new Set(graphCommits.map((c) => c.oid))
      const additions = page.commits.filter((c) => !seen.has(c.oid))
      graphCommits = [...graphCommits, ...additions]
      graphHasMore = page.hasMore
    } catch (e) {
      graphError = e instanceof Error ? e.message : String(e)
    } finally {
      graphLoading = false
    }
  }

  /**
   * Expands or collapses a commit. Expanding lazily fetches the commit's
   * changed files on first open and keeps them cached for the session.
   */
  async function toggleCommit(oid: string): Promise<void> {
    const open = !expanded[oid]
    expanded = { ...expanded, [oid]: open }
    if (!open || commitFiles[oid] || filesLoading[oid]) return
    filesLoading = { ...filesLoading, [oid]: true }
    filesError = omit(filesError, oid)
    try {
      const { files } = await api.commitFiles(oid)
      commitFiles = { ...commitFiles, [oid]: files }
    } catch (e) {
      filesError = { ...filesError, [oid]: e instanceof Error ? e.message : String(e) }
    } finally {
      filesLoading = omit(filesLoading, oid)
    }
  }

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
    if (path == null) {
      selection = null
      commitDiff = null
      return
    }
    if (!snapshot) return
    const change = changesIn(snapshot, scope).find((c) => c.path === path)
    if (change) {
      selection = { scope, change }
      commitDiff = null
    }
  }

  /** Selects a file changed by a commit for display in the diff pane. */
  function selectCommitFile(oid: string, subject: string, file: CommitFile): void {
    selection = null
    commitDiff = { oid, subject, path: file.path, oldPath: file.oldPath, kind: file.kind }
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
      void refreshGraph()
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
    get graphRows() {
      return graphRows
    },
    get graphLoading() {
      return graphLoading
    },
    get graphError() {
      return graphError
    },
    get graphHasMore() {
      return graphHasMore
    },
    get expanded() {
      return expanded
    },
    get commitFiles() {
      return commitFiles
    },
    get filesLoading() {
      return filesLoading
    },
    get filesError() {
      return filesError
    },
    get commitDiff() {
      return commitDiff
    },
    refreshSnapshot,
    connectEvents,
    refreshGraph,
    loadMoreGraph,
    toggleCommit,
    select,
    selectCommitFile,
    mutate,
    commit,
  }
}

export type RepoState = ReturnType<typeof createRepoState>
