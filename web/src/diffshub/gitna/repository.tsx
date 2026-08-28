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
  CommitStats,
  ConflictEntry,
  FileChange,
  GraphCommit,
  RepoSnapshot,
  StashEntry,
  Tag,
  FolderCatalog,
  WorktreeFile,
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
  'open-folder': 'Opening folder',
  'save-file': 'Saving file',
  'create-entry': 'Creating entry',
  'rename-entry': 'Renaming entry',
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
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
  folders: FolderCatalog | null = null
  foldersLoading = false
  foldersError: string | null = null
  loading = false
  error: string | null = null
  mutationError: string | null = null
  busy = false
  activeOp: string | null = null
  generation = 0
  selection: Selection | null = null
  repositoryFilePath: string | null = null
  repositoryOpenPaths: string[] = []
  repositoryFileRevealVersion = 0
  worktreeRename: { source: string; destination: string; version: number } | null = null

  repositoryPaths: string[] = []
  repositoryIgnoredPaths = new Set<string>()
  repositoryFilesLoading = false
  repositoryFilesError: string | null = null
  repositoryFilesTruncated = false

  graphCommits: GraphCommit[] = []
  graphRows: GraphRow[] = []
  graphLoading = false
  graphError: string | null = null
  graphHasMore = false
  expanded: Record<string, boolean> = {}
  commitFiles: Record<string, CommitFile[]> = {}
  commitStats: Record<string, CommitStats> = {}
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
  private repositoryEpoch = 0
  private folderRequest = 0
  private graphRequest = 0
  private branchesRequest = 0
  private stashesRequest = 0
  private tagsRequest = 0
  private compareRequest = 0
  private conflictsRequest = 0
  private repositoryFilesGeneration = 0
  private repositoryFilesRequest = 0

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
        const epoch = this.repositoryEpoch
        try {
          const snapshot = await this.api.snapshot()
          if (epoch !== this.repositoryEpoch || snapshot.generation <= this.generation) continue
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
          if (epoch === this.repositoryEpoch) this.error = errorMessage(error)
        } finally {
          if (epoch === this.repositoryEpoch) {
            this.loading = false
            this.emit()
          }
        }
      }
    })()

    try {
      await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  async refreshFolders(): Promise<void> {
    const request = ++this.folderRequest
    this.foldersLoading = true
    this.foldersError = null
    this.emit()
    try {
      const folders = await this.api.folders()
      if (request !== this.folderRequest) return
      this.folders = folders
    } catch (error) {
      if (request === this.folderRequest) this.foldersError = errorMessage(error)
    } finally {
      if (request === this.folderRequest) {
        this.foldersLoading = false
        this.emit()
      }
    }
  }

  async refreshRepositoryFiles(): Promise<void> {
    const request = ++this.repositoryFilesRequest
    this.repositoryFilesLoading = true
    this.repositoryFilesError = null
    this.emit()
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let cursor: string | undefined
        let pageGeneration: number | undefined
        const paths: string[] = []
        const ignoredPaths = new Set<string>()
        let restart = false
        do {
          const files = await this.api.repositoryFiles(cursor)
          if (request !== this.repositoryFilesRequest) return
          if (pageGeneration == null) pageGeneration = files.generation
          if (files.generation !== pageGeneration) {
            restart = true
            break
          }
          paths.push(...files.paths)
          for (const path of files.ignoredPaths ?? []) ignoredPaths.add(path)
          cursor = files.nextCursor
        } while (cursor != null && cursor !== '')

        if (restart) continue
        if ((pageGeneration ?? 0) < this.repositoryFilesGeneration) return
        this.repositoryFilesGeneration = pageGeneration ?? this.repositoryFilesGeneration
        if (!sameStrings(this.repositoryPaths, paths)) this.repositoryPaths = paths
        if (!sameStringSet(this.repositoryIgnoredPaths, ignoredPaths)) {
          this.repositoryIgnoredPaths = ignoredPaths
        }
        this.repositoryFilesTruncated = false
        return
      }
      throw new Error('Repository changed while files were loading')
    } catch (error) {
      if (request === this.repositoryFilesRequest) {
        this.repositoryFilesError = errorMessage(error)
      }
    } finally {
      if (request === this.repositoryFilesRequest) {
        this.repositoryFilesLoading = false
        this.emit()
      }
    }
  }

  async refreshCurrentFolder(): Promise<void> {
    await Promise.all([
      this.refreshSnapshot(),
      this.refreshFolders(),
      this.refreshRepositoryFiles(),
    ])
    if (this.snapshot?.repository) {
      await Promise.all([
        this.refreshGraph(),
        this.refreshBranches(),
        this.refreshStashes(),
        this.refreshTags(),
      ])
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
        void Promise.all([this.refreshSnapshot(), this.refreshRepositoryFiles()])
      }, 150)
    }
    source.addEventListener('snapshot-invalidated', scheduleSnapshot)
    source.addEventListener('graph-invalidated', () => {
      scheduleSnapshot()
      if (this.snapshot?.repository) void this.refreshGraph()
    })
    return () => {
      if (this.refreshTimer != null) clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      source.close()
      if (this.eventSource === source) this.eventSource = null
    }
  }

  async refreshGraph(): Promise<void> {
    const request = ++this.graphRequest
    const epoch = this.repositoryEpoch
    this.graphLoading = true
    this.graphError = null
    this.emit()
    try {
      const page = await this.api.graph(0)
      if (request !== this.graphRequest || epoch !== this.repositoryEpoch) return
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
      this.commitStats = Object.fromEntries(
        Object.entries(this.commitStats).filter(([oid]) => present.has(oid)),
      )
      if (this.commitDiff != null && !present.has(this.commitDiff.oid)) {
        this.commitDiff = null
      }
    } catch (error) {
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphError = errorMessage(error)
      }
    } finally {
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphLoading = false
        this.emit()
      }
    }
  }

  async loadMoreGraph(): Promise<void> {
    const request = ++this.graphRequest
    const epoch = this.repositoryEpoch
    const skip = this.graphCommits.length
    this.graphLoading = true
    this.emit()
    try {
      const page = await this.api.graph(skip)
      if (request !== this.graphRequest || epoch !== this.repositoryEpoch) return
      const seen = new Set(this.graphCommits.map((commit) => commit.oid))
      this.graphCommits = [
        ...this.graphCommits,
        ...page.commits.filter((commit) => !seen.has(commit.oid)),
      ]
      this.graphRows = computeGraph(this.graphCommits)
      this.graphHasMore = page.hasMore
      this.graphError = null
    } catch (error) {
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphError = errorMessage(error)
      }
    } finally {
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphLoading = false
        this.emit()
      }
    }
  }

  async loadCommitDetails(oid: string): Promise<void> {
    if (this.commitFiles[oid] != null || this.filesLoading[oid]) return
    const epoch = this.repositoryEpoch
    this.filesLoading = { ...this.filesLoading, [oid]: true }
    const { [oid]: _previous, ...remainingErrors } = this.filesError
    this.filesError = remainingErrors
    this.emit()
    try {
      const { files, stats } = await this.api.commitFiles(oid)
      if (epoch !== this.repositoryEpoch) return
      this.commitFiles = { ...this.commitFiles, [oid]: files }
      if (stats != null) this.commitStats = { ...this.commitStats, [oid]: stats }
    } catch (error) {
      if (epoch === this.repositoryEpoch) {
        this.filesError = { ...this.filesError, [oid]: errorMessage(error) }
      }
    } finally {
      if (epoch === this.repositoryEpoch) {
        const { [oid]: _loading, ...remainingLoading } = this.filesLoading
        this.filesLoading = remainingLoading
        this.emit()
      }
    }
  }

  async toggleCommit(oid: string): Promise<void> {
    const open = !this.expanded[oid]
    this.expanded = { ...this.expanded, [oid]: open }
    this.emit()
    if (open) await this.loadCommitDetails(oid)
  }

  select(scope: ChangeScope, path: string | null): void {
    if (path == null) {
      this.selection = null
      this.repositoryFilePath = null
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
    this.repositoryFilePath = null
    this.commitDiff = null
    this.compareDiff = null
    this.emit()
  }

  canOpenRepositoryFile(path: string): boolean {
    if (this.repositoryPaths.includes(path)) return true
    const snapshot = this.snapshot
    if (snapshot == null) return false
    return [...snapshot.staged, ...snapshot.unstaged].some(
      (change) => change.path === path && change.kind !== 'deleted',
    )
  }

  selectRepositoryFile(path: string, reveal = false): void {
    if (!this.canOpenRepositoryFile(path) && !this.repositoryOpenPaths.includes(path)) return
    this.selection = null
    this.commitDiff = null
    this.compareDiff = null
    this.repositoryFilePath = path
    if (!this.repositoryOpenPaths.includes(path)) {
      this.repositoryOpenPaths = [...this.repositoryOpenPaths, path]
    }
    if (reveal) this.repositoryFileRevealVersion += 1
    this.emit()
  }

  closeRepositoryFiles(paths: readonly string[]): void {
    const closing = new Set(paths)
    if (!this.repositoryOpenPaths.some((path) => closing.has(path))) return
    const openPaths = this.repositoryOpenPaths
    const currentPath = this.repositoryFilePath
    const currentIndex = currentPath == null ? -1 : openPaths.indexOf(currentPath)
    const nextOpenPaths = openPaths.filter((path) => !closing.has(path))
    this.repositoryOpenPaths = nextOpenPaths
    if (currentPath != null && closing.has(currentPath)) {
      const nextPath = openPaths.slice(currentIndex + 1).find((path) => !closing.has(path))
      const previousPath = openPaths.slice(0, currentIndex).findLast((path) => !closing.has(path))
      this.repositoryFilePath = nextPath ?? previousPath ?? null
    }
    this.emit()
  }

  selectCommitFile(oid: string, subject: string, file: CommitFile): void {
    this.selection = null
    this.repositoryFilePath = null
    this.compareDiff = null
    this.commitDiff = { oid, subject, ...file }
    this.emit()
  }

  selectCompareFile(file: CommitFile): void {
    if (this.compare == null) return
    this.selection = null
    this.repositoryFilePath = null
    this.commitDiff = null
    this.compareDiff = {
      from: this.compare.from,
      to: this.compare.to,
      ...file,
    }
    this.emit()
  }

  async refreshBranches(): Promise<void> {
    const request = ++this.branchesRequest
    const epoch = this.repositoryEpoch
    this.branchesLoading = true
    this.branchesError = null
    this.emit()
    try {
      const branches = await this.api.branches()
      if (request === this.branchesRequest && epoch === this.repositoryEpoch) {
        this.branches = branches
      }
    } catch (error) {
      if (request === this.branchesRequest && epoch === this.repositoryEpoch) {
        this.branchesError = errorMessage(error)
      }
    } finally {
      if (request === this.branchesRequest && epoch === this.repositoryEpoch) {
        this.branchesLoading = false
        this.emit()
      }
    }
  }

  async refreshStashes(): Promise<void> {
    const request = ++this.stashesRequest
    const epoch = this.repositoryEpoch
    this.stashesLoading = true
    this.stashesError = null
    this.emit()
    try {
      const stashes = await this.api.stashes()
      if (request === this.stashesRequest && epoch === this.repositoryEpoch) {
        this.stashes = stashes
      }
    } catch (error) {
      if (request === this.stashesRequest && epoch === this.repositoryEpoch) {
        this.stashesError = errorMessage(error)
      }
    } finally {
      if (request === this.stashesRequest && epoch === this.repositoryEpoch) {
        this.stashesLoading = false
        this.emit()
      }
    }
  }

  async refreshTags(): Promise<void> {
    const request = ++this.tagsRequest
    const epoch = this.repositoryEpoch
    this.tagsLoading = true
    this.tagsError = null
    this.emit()
    try {
      const tags = await this.api.tags()
      if (request === this.tagsRequest && epoch === this.repositoryEpoch) {
        this.tags = tags
      }
    } catch (error) {
      if (request === this.tagsRequest && epoch === this.repositoryEpoch) {
        this.tagsError = errorMessage(error)
      }
    } finally {
      if (request === this.tagsRequest && epoch === this.repositoryEpoch) {
        this.tagsLoading = false
        this.emit()
      }
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
      if (this.commitDiff != null) await this.refreshGraph()
      await Promise.allSettled([this.refreshSnapshot(), this.refreshRepositoryFiles()])
      this.busy = false
      this.activeOp = null
      this.emit()
    }
  }

  async saveWorktreeFile(
    path: string,
    content: string,
    expectedHash: string,
  ): Promise<WorktreeFile> {
    return this.runWorktreeOperation('save-file', () =>
      this.api.writeWorktreeFile(path, content, expectedHash),
    )
  }

  async createWorktreeEntry(path: string, directory: boolean): Promise<void> {
    await this.runWorktreeOperation('create-entry', () =>
      this.api.createWorktreeEntry(path, directory),
    )
    if (!directory) this.selectRepositoryFile(path)
  }

  async renameWorktreeEntry(source: string, destination: string): Promise<void> {
    const sourcePrefix = source.endsWith('/') ? source : `${source}/`
    const destinationPrefix = destination.endsWith('/') ? destination : `${destination}/`
    const remap = (path: string) =>
      path === source
        ? destination
        : path.startsWith(sourcePrefix)
          ? `${destinationPrefix}${path.slice(sourcePrefix.length)}`
          : path
    const openPaths = this.repositoryOpenPaths.map(remap)
    const selectedPath = this.repositoryFilePath == null ? null : remap(this.repositoryFilePath)
    await this.runWorktreeOperation('rename-entry', () =>
      this.api.renameWorktreeEntry(source, destination),
    )
    this.repositoryOpenPaths = openPaths.filter((path) => this.repositoryPaths.includes(path))
    this.repositoryFilePath =
      selectedPath != null && this.repositoryPaths.includes(selectedPath) ? selectedPath : null
    this.worktreeRename = {
      source,
      destination,
      version: (this.worktreeRename?.version ?? 0) + 1,
    }
    this.emit()
  }

  private async runWorktreeOperation<T>(label: string, run: () => Promise<T>): Promise<T> {
    this.busy = true
    this.activeOp = label
    this.emit()
    try {
      const result = await run()
      this.mutationError = null
      return result
    } catch (error) {
      this.mutationError = errorMessage(error)
      throw error
    } finally {
      await Promise.allSettled([this.refreshSnapshot(), this.refreshRepositoryFiles()])
      this.busy = false
      this.activeOp = null
      this.emit()
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
      await Promise.allSettled([
        this.refreshSnapshot(),
        this.refreshRepositoryFiles(),
        this.refreshGraph(),
        this.refreshBranches(),
        this.refreshStashes(),
        this.refreshTags(),
      ])
      this.busy = false
      this.activeOp = null
      this.emit()
    }
  }

  async openFolder(path: string): Promise<{ root: string; href: string }> {
    this.busy = true
    this.activeOp = 'open-folder'
    this.mutationError = null
    this.emit()
    try {
      return await this.api.openFolder(path)
    } catch (error) {
      this.mutationError = errorMessage(error)
      throw error
    } finally {
      this.busy = false
      this.activeOp = null
      this.emit()
    }
  }

  async removeRecentFolder(path: string): Promise<void> {
    await this.api.removeRecentFolder(path)
    if (this.folders != null) {
      this.folders = {
        ...this.folders,
        recent: this.folders.recent.filter((folder) => folder.path !== path),
      }
      this.emit()
    }
    await this.refreshFolders()
  }

  revealFolder(): Promise<void> {
    return this.api.revealFolder()
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
      await Promise.all([
        this.refreshSnapshot(),
        this.refreshRepositoryFiles(),
        this.refreshGraph(),
      ])
    }
  }

  async openCompare(from: string, to: string, label: string): Promise<void> {
    const request = ++this.compareRequest
    const epoch = this.repositoryEpoch
    this.compare = { from, to, label }
    this.compareLoading = true
    this.compareError = null
    this.compareDiff = null
    this.emit()
    try {
      const { files } = await this.api.compare(from, to)
      if (request === this.compareRequest && epoch === this.repositoryEpoch) {
        this.compareFiles = files
      }
    } catch (error) {
      if (request === this.compareRequest && epoch === this.repositoryEpoch) {
        this.compareError = errorMessage(error)
        this.compareFiles = []
      }
    } finally {
      if (request === this.compareRequest && epoch === this.repositoryEpoch) {
        this.compareLoading = false
        this.emit()
      }
    }
  }

  clearCompare(): void {
    this.compareRequest += 1
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
    void repository.refreshCurrentFolder()
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
