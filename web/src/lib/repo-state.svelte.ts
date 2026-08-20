import { createApi, type ApiClient, type MutateRequest } from './api'
import { computeGraph } from './graph-lanes'
import type {
  Branch,
  ChangeKind,
  ChangeScope,
  CommitFile,
  ConflictEntry,
  FileChange,
  GraphCommit,
  RepoSnapshot,
  StashEntry,
  Tag,
} from './types'

/** Human-readable labels for operation names. */
const opLabels: Record<string, string> = {
  stage: 'Staging',
  unstage: 'Unstaging',
  discard: 'Discarding',
  delete: 'Deleting',
  patch: 'Applying patch',
  commit: 'Committing',
  'create-branch': 'Creating branch',
  'switch-branch': 'Switching branch',
  'delete-branch': 'Deleting branch',
  fetch: 'Fetching',
  pull: 'Pulling',
  push: 'Pushing',
  'push-upstream': 'Publishing',
  'stash-push': 'Stashing',
  'stash-apply': 'Applying stash',
  'stash-pop': 'Popping stash',
  'stash-drop': 'Dropping stash',
  'create-tag': 'Creating tag',
  'delete-tag': 'Deleting tag',
  'push-tag': 'Pushing tag',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
  reset: 'Resetting',
  merge: 'Merging',
  'merge-abort': 'Aborting merge',
  'merge-continue': 'Continuing merge',
  rebase: 'Rebasing',
  'rebase-abort': 'Aborting rebase',
  'rebase-continue': 'Continuing rebase',
  'resolve-ours': 'Resolving conflict',
  'resolve-theirs': 'Resolving conflict',
}

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

/** Two refs being compared, with a human label for the compare view. */
export interface CompareTarget {
  from: string
  to: string
  label: string
}

/** A file in a compare view, selected for display in the diff pane. */
export interface CompareDiffTarget {
  from: string
  to: string
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
  let activeOp = $state<string | null>(null)

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

  let branches = $state<Branch[]>([])
  let branchesLoading = $state(false)
  let branchesError = $state<string | null>(null)

  let stashes = $state<StashEntry[]>([])
  let stashesLoading = $state(false)
  let stashesError = $state<string | null>(null)

  let tags = $state<Tag[]>([])
  let tagsLoading = $state(false)
  let tagsError = $state<string | null>(null)

  let compare = $state<CompareTarget | null>(null)
  let compareFiles = $state<CommitFile[]>([])
  let compareLoading = $state(false)
  let compareError = $state<string | null>(null)
  let compareDiff = $state<CompareDiffTarget | null>(null)

  let conflicts = $state<ConflictEntry[]>([])
  let conflictsLoading = $state(false)
  let conflictsError = $state<string | null>(null)

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
      const op = snap.operation
      if (op === 'merge' || op === 'rebase') {
        void refreshConflicts()
      } else if (conflicts.length > 0) {
        conflicts = []
      }
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
    source.addEventListener('graph-invalidated', () => {
      scheduleRefresh()
      void refreshGraph()
    })
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
      compareDiff = null
    }
  }

  /** Selects a file changed by a commit for display in the diff pane. */
  function selectCommitFile(oid: string, subject: string, file: CommitFile): void {
    selection = null
    compareDiff = null
    commitDiff = { oid, subject, path: file.path, oldPath: file.oldPath, kind: file.kind }
  }

  /**
   * Replaces the branch list with the current set of local and remote
   * branches, used by the branch menu and the push-with-upstream flow.
   */
  async function refreshBranches(): Promise<void> {
    branchesLoading = true
    branchesError = null
    try {
      branches = await api.branches()
    } catch (e) {
      branchesError = e instanceof Error ? e.message : String(e)
    } finally {
      branchesLoading = false
    }
  }

  /** Refreshes the stash list after any operation that can create or consume a
   * stash entry (stash push/apply/pop/drop, or a branch switch). */
  async function refreshStashes(): Promise<void> {
    stashesLoading = true
    stashesError = null
    try {
      stashes = await api.stashes()
    } catch (e) {
      stashesError = e instanceof Error ? e.message : String(e)
    } finally {
      stashesLoading = false
    }
  }

  /** Refreshes the tag list; tags also appear as refs on the graph. */
  async function refreshTags(): Promise<void> {
    tagsLoading = true
    tagsError = null
    try {
      tags = await api.tags()
    } catch (e) {
      tagsError = e instanceof Error ? e.message : String(e)
    } finally {
      tagsLoading = false
    }
  }

  /** Refreshes the conflict list when a merge or rebase is in progress. */
  async function refreshConflicts(): Promise<void> {
    conflictsLoading = true
    conflictsError = null
    try {
      conflicts = await api.conflicts()
    } catch (e) {
      conflictsError = e instanceof Error ? e.message : String(e)
    } finally {
      conflictsLoading = false
    }
  }

  /**
   * Applies a repository mutation, then refreshes the snapshot so the index
   * and worktree views reflect the change. Failures are recorded in
   * mutationError (which the follow-up snapshot refresh leaves untouched), and
   * the rejection propagates to the caller.
   */
  async function mutate(request: MutateRequest): Promise<void> {
    busy = true
    activeOp = request.op
    try {
      await api.mutate(request)
      mutationError = null
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') {
        mutationError = 'Operation timed out'
      } else {
        mutationError = e instanceof Error ? e.message : String(e)
      }
      throw e
    } finally {
      busy = false
      activeOp = null
      void refreshSnapshot()
    }
  }

  /**
   * Applies a branch, sync, or ref operation that can move refs (switch, push,
   * pull, fetch, stash, tags, history mutations, …), then refreshes every
   * ref-derived view: the snapshot, the graph, the branch list, the stash list,
   * and the tag list. Failures are recorded in mutationError and propagate so
   * the caller can react to structured classifications such as no-upstream.
   */
  async function operation(request: MutateRequest): Promise<void> {
    busy = true
    activeOp = request.op
    try {
      await api.mutate(request)
      mutationError = null
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') {
        mutationError = 'Operation timed out'
      } else {
        mutationError = e instanceof Error ? e.message : String(e)
      }
      throw e
    } finally {
      busy = false
      activeOp = null
      void refreshSnapshot()
      void refreshGraph()
      void refreshBranches()
      void refreshStashes()
      void refreshTags()
    }
  }

  function createBranch(name: string, start?: string): Promise<void> {
    return operation({ op: 'create-branch', name, start })
  }

  function switchBranch(name: string): Promise<void> {
    return operation({ op: 'switch-branch', name })
  }

  function deleteBranch(name: string, force = false): Promise<void> {
    return operation({ op: 'delete-branch', name, force })
  }

  function fetchRemote(): Promise<void> {
    return operation({ op: 'fetch' })
  }

  function pullRemote(): Promise<void> {
    return operation({ op: 'pull' })
  }

  function pushRemote(): Promise<void> {
    return operation({ op: 'push' })
  }

  function pushSetUpstream(remote: string, branch: string): Promise<void> {
    return operation({ op: 'push-upstream', remote, name: branch })
  }

  function stashPush(message: string, includeUntracked = false): Promise<void> {
    return operation({ op: 'stash-push', message, includeUntracked })
  }

  function stashApply(ref: string): Promise<void> {
    return operation({ op: 'stash-apply', ref })
  }

  function stashPop(ref: string): Promise<void> {
    return operation({ op: 'stash-pop', ref })
  }

  function stashDrop(ref: string): Promise<void> {
    return operation({ op: 'stash-drop', ref })
  }

  function createTag(name: string, start: string | undefined, message: string): Promise<void> {
    return operation({ op: 'create-tag', name, start, message })
  }

  function deleteTag(name: string): Promise<void> {
    return operation({ op: 'delete-tag', name })
  }

  function pushTag(remote: string, name: string): Promise<void> {
    return operation({ op: 'push-tag', remote, name })
  }

  function cherryPick(oid: string): Promise<void> {
    return operation({ op: 'cherry-pick', ref: oid })
  }

  function revertCommit(oid: string): Promise<void> {
    return operation({ op: 'revert', ref: oid })
  }

  function resetTo(target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    return operation({ op: 'reset', ref: target, mode })
  }

  function mergeBranch(branch: string): Promise<void> {
    return operation({ op: 'merge', name: branch })
  }

  function mergeAbort(): Promise<void> {
    return operation({ op: 'merge-abort' })
  }

  function mergeContinue(): Promise<void> {
    return operation({ op: 'merge-continue' })
  }

  function rebaseBranch(upstream: string): Promise<void> {
    return operation({ op: 'rebase', name: upstream })
  }

  function rebaseAbort(): Promise<void> {
    return operation({ op: 'rebase-abort' })
  }

  function rebaseContinue(): Promise<void> {
    return operation({ op: 'rebase-continue' })
  }

  function resolveOurs(path: string): Promise<void> {
    return operation({ op: 'resolve-ours', paths: [path] })
  }

  function resolveTheirs(path: string): Promise<void> {
    return operation({ op: 'resolve-theirs', paths: [path] })
  }

  /**
   * Opens the compare view between two refs and fetches the change set. The
   * result reuses the commit-file list shape so the compare pane renders like
   * an expanded commit.
   */
  async function openCompare(from: string, to: string, label: string): Promise<void> {
    compare = { from, to, label }
    compareLoading = true
    compareError = null
    compareDiff = null
    try {
      const { files } = await api.compare(from, to)
      compareFiles = files
    } catch (e) {
      compareError = e instanceof Error ? e.message : String(e)
      compareFiles = []
    } finally {
      compareLoading = false
    }
  }

  /** Selects a file from the compare view for display in the diff pane. */
  function selectCompareFile(file: CommitFile): void {
    if (!compare) return
    selection = null
    commitDiff = null
    compareDiff = {
      from: compare.from,
      to: compare.to,
      path: file.path,
      oldPath: file.oldPath,
      kind: file.kind,
    }
  }

  function clearCompare(): void {
    compare = null
    compareFiles = []
    compareDiff = null
    compareError = null
  }

  /**
   * Commits the staged changes with the given message, or amends HEAD. Git
   * hooks run normally: a rejected commit surfaces through mutationError while
   * the rejection propagates so the composer can keep the user's text.
   */
  async function commit(message: string, amend = false): Promise<void> {
    busy = true
    activeOp = 'commit'
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
      if (e instanceof DOMException && e.name === 'TimeoutError') {
        mutationError ??= 'Commit timed out'
      } else {
        mutationError ??= e instanceof Error ? e.message : String(e)
      }
      throw e
    } finally {
      busy = false
      activeOp = null
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
    get activeOp() {
      return activeOp
    },
    get activeOpLabel() {
      return activeOp ? (opLabels[activeOp] ?? activeOp) : null
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
    get branches() {
      return branches
    },
    get branchesLoading() {
      return branchesLoading
    },
    get branchesError() {
      return branchesError
    },
    get stashes() {
      return stashes
    },
    get stashesLoading() {
      return stashesLoading
    },
    get stashesError() {
      return stashesError
    },
    get tags() {
      return tags
    },
    get tagsLoading() {
      return tagsLoading
    },
    get tagsError() {
      return tagsError
    },
    get compare() {
      return compare
    },
    get compareFiles() {
      return compareFiles
    },
    get compareLoading() {
      return compareLoading
    },
    get compareError() {
      return compareError
    },
    get compareDiff() {
      return compareDiff
    },
    get conflicts() {
      return conflicts
    },
    get conflictsLoading() {
      return conflictsLoading
    },
    get conflictsError() {
      return conflictsError
    },
    refreshSnapshot,
    connectEvents,
    refreshGraph,
    refreshBranches,
    refreshStashes,
    refreshTags,
    loadMoreGraph,
    toggleCommit,
    select,
    selectCommitFile,
    selectCompareFile,
    mutate,
    commit,
    createBranch,
    switchBranch,
    deleteBranch,
    fetchRemote,
    pullRemote,
    pushRemote,
    pushSetUpstream,
    stashPush,
    stashApply,
    stashPop,
    stashDrop,
    createTag,
    deleteTag,
    pushTag,
    cherryPick,
    revertCommit,
    resetTo,
    openCompare,
    clearCompare,
    refreshConflicts,
    mergeBranch,
    mergeAbort,
    mergeContinue,
    rebaseBranch,
    rebaseAbort,
    rebaseContinue,
    resolveOurs,
    resolveTheirs,
  }
}

export type RepoState = ReturnType<typeof createRepoState>
