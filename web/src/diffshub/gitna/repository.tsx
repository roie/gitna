import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'

import { createApi, type ApiClient, type MutateRequest } from '../../lib/api'
import { computeGraph, type GraphRow } from '../../lib/graph-lanes'
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
} from '../../lib/types'

export interface Selection {
  scope: ChangeScope
  change: FileChange
}

export interface CommitDiffTarget {
  oid: string
  subject: string
  path: string
  oldPath?: string
  kind: ChangeKind
}

export interface CompareTarget {
  from: string
  to: string
  label: string
}

export interface CompareDiffTarget {
  from: string
  to: string
  path: string
  oldPath?: string
  kind: ChangeKind
}

const OP_LABELS: Record<string, string> = {
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
  'cherry-pick-abort': 'Aborting cherry-pick',
  'cherry-pick-continue': 'Continuing cherry-pick',
  revert: 'Reverting',
  'revert-abort': 'Aborting revert',
  'revert-continue': 'Continuing revert',
  reset: 'Resetting',
  merge: 'Merging',
  'merge-abort': 'Aborting merge',
  'merge-continue': 'Continuing merge',
  rebase: 'Rebasing',
  'rebase-abort': 'Aborting rebase',
  'rebase-continue': 'Continuing rebase',
  'resolve-ours': 'Resolving conflict',
  'resolve-theirs': 'Resolving conflict',
  'resolve-both': 'Resolving conflict',
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'Operation timed out'
  }
  return error instanceof Error ? error.message : String(error)
}

function changeList(snapshot: RepoSnapshot, scope: ChangeScope): FileChange[] {
  return scope === 'staged' ? snapshot.staged : snapshot.unstaged
}

export function reconcileSelection(
  selection: Selection | null,
  staged: FileChange[],
  unstaged: FileChange[],
): Selection | null {
  if (selection == null) return null
  const current = selection.scope === 'staged' ? staged : unstaged
  const existing = current.find((change) => change.path === selection.change.path)
  if (existing != null) return { scope: selection.scope, change: existing }
  const ordered = [...staged, ...unstaged]
  const nearest = ordered.find((change) => change.path >= selection.change.path) ?? ordered.at(-1)
  return nearest == null ? null : { scope: nearest.scope, change: nearest }
}

export function coalesce(refresh: () => void, delay = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  return () => {
    if (pending) return
    pending = true
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      pending = false
      refresh()
    }, delay)
  }
}

export class GitnaRepository {
  readonly api: ApiClient

  snapshot: RepoSnapshot | null = null
  loading = false
  error: string | null = null
  mutationError: string | null = null
  busy = false
  activeOp: string | null = null
  generation = 0
  selection: Selection | null = null

  graphCommits: GraphCommit[] = []
  graphRows: GraphRow[] = []
  graphLoading = false
  graphError: string | null = null
  graphHasMore = false
  expanded: Record<string, boolean> = {}
  commitFiles: Record<string, CommitFile[]> = {}
  filesLoading: Record<string, boolean> = {}
  filesError: Record<string, string> = {}
  commitDiff: CommitDiffTarget | null = null

  branches: Branch[] = []
  branchesLoading = false
  branchesError: string | null = null
  stashes: StashEntry[] = []
  stashesLoading = false
  stashesError: string | null = null
  tags: Tag[] = []
  tagsLoading = false
  tagsError: string | null = null

  compare: CompareTarget | null = null
  compareFiles: CommitFile[] = []
  compareLoading = false
  compareError: string | null = null
  compareDiff: CompareDiffTarget | null = null

  conflicts: ConflictEntry[] = []
  conflictsLoading = false
  conflictsError: string | null = null

  private version = 0
  private readonly listeners = new Set<() => void>()
  private eventSource: EventSource | null = null
  private refreshPromise: Promise<void> | null = null
  private refreshAgain = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private conflictsRequest = 0

  constructor(api: ApiClient = createApi()) {
    this.api = api
  }

  get activeOpLabel(): string | null {
    return this.activeOp == null ? null : (OP_LABELS[this.activeOp] ?? this.activeOp)
  }

  get selectedChange(): FileChange | null {
    return this.selection?.change ?? null
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  async refreshSnapshot(): Promise<void> {
    this.refreshAgain = true
    if (this.refreshPromise != null) return this.refreshPromise

    this.refreshPromise = (async () => {
      while (this.refreshAgain) {
        this.refreshAgain = false
        this.loading = true
        this.error = null
        this.emit()
        try {
          const snapshot = await this.api.snapshot()
          if (snapshot.generation <= this.generation) continue
          this.generation = snapshot.generation
          this.snapshot = snapshot
          this.selection = reconcileSelection(this.selection, snapshot.staged, snapshot.unstaged)
          this.conflictsRequest += 1
          this.conflicts =
            snapshot.operation === 'merge' ||
            snapshot.operation === 'rebase' ||
            snapshot.operation === 'cherry-pick' ||
            snapshot.operation === 'revert'
              ? (snapshot.conflicts ?? [])
              : []
          this.conflictsLoading = false
          this.conflictsError = null
        } catch (error) {
          this.error = errorMessage(error)
        } finally {
          this.loading = false
          this.emit()
        }
      }
    })()

    try {
      await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  connectEvents(): () => void {
    if (this.eventSource != null) return () => {}
    const source = new EventSource('api/v1/events')
    this.eventSource = source
    const scheduleSnapshot = () => {
      if (this.refreshTimer != null) return
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null
        void this.refreshSnapshot()
      }, 150)
    }
    source.addEventListener('snapshot-invalidated', scheduleSnapshot)
    source.addEventListener('graph-invalidated', () => {
      scheduleSnapshot()
      void this.refreshGraph()
    })
    return () => {
      if (this.refreshTimer != null) clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      source.close()
      if (this.eventSource === source) this.eventSource = null
    }
  }

  async refreshGraph(): Promise<void> {
    this.graphLoading = true
    this.graphError = null
    this.emit()
    try {
      const page = await this.api.graph(0)
      this.graphCommits = page.commits
      this.graphRows = computeGraph(page.commits)
      this.graphHasMore = page.hasMore
      const present = new Set(page.commits.map((commit) => commit.oid))
      this.expanded = Object.fromEntries(
        Object.entries(this.expanded).filter(([oid, open]) => open && present.has(oid)),
      )
      this.commitFiles = Object.fromEntries(
        Object.entries(this.commitFiles).filter(([oid]) => present.has(oid)),
      )
    } catch (error) {
      this.graphError = errorMessage(error)
    } finally {
      this.graphLoading = false
      this.emit()
    }
  }

  async loadMoreGraph(): Promise<void> {
    this.graphLoading = true
    this.emit()
    try {
      const page = await this.api.graph(this.graphCommits.length)
      const seen = new Set(this.graphCommits.map((commit) => commit.oid))
      this.graphCommits = [
        ...this.graphCommits,
        ...page.commits.filter((commit) => !seen.has(commit.oid)),
      ]
      this.graphRows = computeGraph(this.graphCommits)
      this.graphHasMore = page.hasMore
      this.graphError = null
    } catch (error) {
      this.graphError = errorMessage(error)
    } finally {
      this.graphLoading = false
      this.emit()
    }
  }

  async toggleCommit(oid: string): Promise<void> {
    const open = !this.expanded[oid]
    this.expanded = { ...this.expanded, [oid]: open }
    this.emit()
    if (!open || this.commitFiles[oid] != null || this.filesLoading[oid]) return
    this.filesLoading = { ...this.filesLoading, [oid]: true }
    const { [oid]: _previous, ...remainingErrors } = this.filesError
    this.filesError = remainingErrors
    this.emit()
    try {
      const { files } = await this.api.commitFiles(oid)
      this.commitFiles = { ...this.commitFiles, [oid]: files }
    } catch (error) {
      this.filesError = { ...this.filesError, [oid]: errorMessage(error) }
    } finally {
      const { [oid]: _loading, ...remainingLoading } = this.filesLoading
      this.filesLoading = remainingLoading
      this.emit()
    }
  }

  select(scope: ChangeScope, path: string | null): void {
    if (path == null) {
      this.selection = null
      this.commitDiff = null
      this.emit()
      return
    }
    const change =
      this.snapshot == null
        ? undefined
        : changeList(this.snapshot, scope).find((candidate) => candidate.path === path)
    if (change == null) return
    this.selection = { scope, change }
    this.commitDiff = null
    this.compareDiff = null
    this.emit()
  }

  selectCommitFile(oid: string, subject: string, file: CommitFile): void {
    this.selection = null
    this.compareDiff = null
    this.commitDiff = { oid, subject, ...file }
    this.emit()
  }

  selectCompareFile(file: CommitFile): void {
    if (this.compare == null) return
    this.selection = null
    this.commitDiff = null
    this.compareDiff = {
      from: this.compare.from,
      to: this.compare.to,
      ...file,
    }
    this.emit()
  }

  async refreshBranches(): Promise<void> {
    this.branchesLoading = true
    this.branchesError = null
    this.emit()
    try {
      this.branches = await this.api.branches()
    } catch (error) {
      this.branchesError = errorMessage(error)
    } finally {
      this.branchesLoading = false
      this.emit()
    }
  }

  async refreshStashes(): Promise<void> {
    this.stashesLoading = true
    this.stashesError = null
    this.emit()
    try {
      this.stashes = await this.api.stashes()
    } catch (error) {
      this.stashesError = errorMessage(error)
    } finally {
      this.stashesLoading = false
      this.emit()
    }
  }

  async refreshTags(): Promise<void> {
    this.tagsLoading = true
    this.tagsError = null
    this.emit()
    try {
      this.tags = await this.api.tags()
    } catch (error) {
      this.tagsError = errorMessage(error)
    } finally {
      this.tagsLoading = false
      this.emit()
    }
  }

  async refreshConflicts(): Promise<void> {
    const request = ++this.conflictsRequest
    this.conflictsLoading = true
    this.conflictsError = null
    this.emit()
    try {
      const conflicts = await this.api.conflicts()
      if (request === this.conflictsRequest) this.conflicts = conflicts
    } catch (error) {
      if (request === this.conflictsRequest) this.conflictsError = errorMessage(error)
    } finally {
      if (request === this.conflictsRequest) {
        this.conflictsLoading = false
        this.emit()
      }
    }
  }

  async mutate(request: MutateRequest): Promise<void> {
    this.busy = true
    this.activeOp = request.op
    this.emit()
    try {
      await this.api.mutate(request)
      this.mutationError = null
    } catch (error) {
      this.mutationError = errorMessage(error)
      throw error
    } finally {
      this.busy = false
      this.activeOp = null
      this.emit()
      void this.refreshSnapshot()
    }
  }

  async operation(request: MutateRequest): Promise<void> {
    this.busy = true
    this.activeOp = request.op
    this.emit()
    try {
      await this.api.mutate(request)
      this.mutationError = null
    } catch (error) {
      this.mutationError = errorMessage(error)
      throw error
    } finally {
      this.busy = false
      this.activeOp = null
      this.emit()
      await Promise.allSettled([
        this.refreshSnapshot(),
        this.refreshGraph(),
        this.refreshBranches(),
        this.refreshStashes(),
        this.refreshTags(),
      ])
    }
  }

  createBranch(name: string, start?: string): Promise<void> {
    return this.operation({ op: 'create-branch', name, start })
  }

  switchBranch(name: string): Promise<void> {
    return this.operation({ op: 'switch-branch', name })
  }

  deleteBranch(name: string, force = false): Promise<void> {
    return this.operation({ op: 'delete-branch', name, force })
  }

  fetchRemote(): Promise<void> {
    return this.operation({ op: 'fetch' })
  }

  pullRemote(): Promise<void> {
    return this.operation({ op: 'pull' })
  }

  pushRemote(): Promise<void> {
    return this.operation({ op: 'push' })
  }

  pushSetUpstream(remote: string, branch: string): Promise<void> {
    return this.operation({ op: 'push-upstream', remote, name: branch })
  }

  stashPush(message: string, includeUntracked = false): Promise<void> {
    return this.operation({ op: 'stash-push', message, includeUntracked })
  }

  stashApply(ref: string): Promise<void> {
    return this.operation({ op: 'stash-apply', ref })
  }

  stashPop(ref: string): Promise<void> {
    return this.operation({ op: 'stash-pop', ref })
  }

  stashDrop(ref: string): Promise<void> {
    return this.operation({ op: 'stash-drop', ref })
  }

  createTag(name: string, start: string | undefined, message: string): Promise<void> {
    return this.operation({ op: 'create-tag', name, start, message })
  }

  deleteTag(name: string): Promise<void> {
    return this.operation({ op: 'delete-tag', name })
  }

  pushTag(remote: string, name: string): Promise<void> {
    return this.operation({ op: 'push-tag', remote, name })
  }

  cherryPick(oid: string): Promise<void> {
    return this.operation({ op: 'cherry-pick', ref: oid })
  }

  cherryPickAbort(): Promise<void> {
    return this.operation({ op: 'cherry-pick-abort' })
  }

  cherryPickContinue(): Promise<void> {
    return this.operation({ op: 'cherry-pick-continue' })
  }

  revertCommit(oid: string): Promise<void> {
    return this.operation({ op: 'revert', ref: oid })
  }

  revertAbort(): Promise<void> {
    return this.operation({ op: 'revert-abort' })
  }

  revertContinue(): Promise<void> {
    return this.operation({ op: 'revert-continue' })
  }

  resetTo(target: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    return this.operation({ op: 'reset', ref: target, mode })
  }

  mergeBranch(branch: string): Promise<void> {
    return this.operation({ op: 'merge', name: branch })
  }

  mergeAbort(): Promise<void> {
    return this.operation({ op: 'merge-abort' })
  }

  mergeContinue(): Promise<void> {
    return this.operation({ op: 'merge-continue' })
  }

  rebaseBranch(upstream: string): Promise<void> {
    return this.operation({ op: 'rebase', name: upstream })
  }

  rebaseAbort(): Promise<void> {
    return this.operation({ op: 'rebase-abort' })
  }

  rebaseContinue(): Promise<void> {
    return this.operation({ op: 'rebase-continue' })
  }

  resolveOurs(path: string): Promise<void> {
    return this.operation({ op: 'resolve-ours', paths: [path] })
  }

  resolveTheirs(path: string): Promise<void> {
    return this.operation({ op: 'resolve-theirs', paths: [path] })
  }

  resolveBoth(path: string): Promise<void> {
    return this.operation({ op: 'resolve-both', paths: [path] })
  }

  async commit(message: string, amend = false): Promise<void> {
    this.busy = true
    this.activeOp = 'commit'
    this.emit()
    try {
      const result = await this.api.commit({ message, amend })
      if (!result.ok) {
        const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
        throw new Error(detail || `commit failed (exit ${result.exitCode ?? 1})`)
      }
      this.mutationError = null
    } catch (error) {
      this.mutationError = errorMessage(error)
      throw error
    } finally {
      this.busy = false
      this.activeOp = null
      this.emit()
      await Promise.all([this.refreshSnapshot(), this.refreshGraph()])
    }
  }

  async openCompare(from: string, to: string, label: string): Promise<void> {
    this.compare = { from, to, label }
    this.compareLoading = true
    this.compareError = null
    this.compareDiff = null
    this.emit()
    try {
      const { files } = await this.api.compare(from, to)
      this.compareFiles = files
    } catch (error) {
      this.compareError = errorMessage(error)
      this.compareFiles = []
    } finally {
      this.compareLoading = false
      this.emit()
    }
  }

  clearCompare(): void {
    this.compare = null
    this.compareFiles = []
    this.compareDiff = null
    this.compareError = null
    this.emit()
  }
}

export function createRepoState(options: { api?: ApiClient } = {}): GitnaRepository {
  return new GitnaRepository(options.api)
}

const RepositoryContext = createContext<GitnaRepository | null>(null)

export function RepositoryProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<GitnaRepository | null>(null)
  storeRef.current ??= new GitnaRepository()
  const repository = storeRef.current

  useEffect(() => {
    void Promise.all([
      repository.refreshSnapshot(),
      repository.refreshGraph(),
      repository.refreshBranches(),
      repository.refreshStashes(),
      repository.refreshTags(),
    ])
    return repository.connectEvents()
  }, [repository])

  return <RepositoryContext.Provider value={repository}>{children}</RepositoryContext.Provider>
}

export function useRepository(): GitnaRepository {
  const repository = useContext(RepositoryContext)
  if (repository == null) throw new Error('Missing Gitna repository provider')
  useSyncExternalStore(repository.subscribe, repository.getVersion, repository.getVersion)
  return repository
}
