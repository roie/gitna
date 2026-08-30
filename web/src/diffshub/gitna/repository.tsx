import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'

import { ApiError, createApi, type ApiClient, type MutateRequest } from '../../lib/api'
import { appendGraph, computeGraph, type GraphRow } from '../../lib/graph-lanes'
import type {
  Branch,
  ChangeKind,
  ChangeScope,
  CommitFile,
  CommitStats,
  ConflictEntry,
  FileChange,
  FileSearchResult,
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

export interface RepositoryFileComparison {
  leftPath: string
  rightPath: string
  version: number
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

export function startupTraceEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URL(window.location.href).searchParams.get('trace-startup') === '1'
}

export function markStartup(name: string): void {
  if (!startupTraceEnabled() || typeof performance === 'undefined') return
  performance.mark(`gitna:${name}`)
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

function graphCountCacheKey(tip: string, generation: number): string {
  return `${generation}:${tip}`
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
  repositorySelectedPaths: string[] = []
  repositoryFileComparison: RepositoryFileComparison | null = null
  repositoryFileComparisonActive = false
  repositoryFileRevealVersion = 0
  worktreeRename: { source: string; destination: string; version: number } | null = null

  repositoryPaths: string[] = []
  repositoryIgnoredPaths = new Set<string>()
  repositoryFilesLoading = false
  repositoryFilesError: string | null = null
  repositoryFilesTruncated = false
  ordinaryUnloadedDirectories = new Set<string>()
  ordinaryPagedDirectories = new Set<string>()
  ordinaryDirectoryErrors = new Map<string, string>()
  ordinaryWatchCoverage: 'complete' | 'partial' = 'complete'
  ordinarySearchResults: FileSearchResult[] = []
  ordinarySearchComplete = false
  ordinarySearchLoading = false
  ordinarySearchError: string | null = null
  private ordinarySearchRequest = 0
  private ordinarySearchController: AbortController | null = null
  private ordinaryDirectoryChildren = new Map<string, string[]>()
  private ordinaryDirectoryCursors = new Map<string, string>()
  private ordinaryDirectoryGenerations = new Map<string, number>()
  private ordinaryDirectoryRequests = new Map<string, Promise<readonly string[] | null>>()
  private ordinaryDirectoryControllers = new Map<string, AbortController>()

  graphCommits: GraphCommit[] = []
  graphRows: GraphRow[] = []
  graphLoading = false
  graphError: string | null = null
  graphHasMore = false
  graphTip = ''
  graphGeneration = 0
  graphTotal: number | null = null
  graphCountLoading = false
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
  private graphCountRequest = 0
  private graphController: AbortController | null = null
  private graphCountController: AbortController | null = null
  private graphCountCache = new Map<string, number>()
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
          markStartup('snapshot-ready')
          markStartup('source-control-ready')
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
    if (this.snapshot?.repository === false) {
      await this.refreshOrdinaryDirectories()
      return
    }
    const request = ++this.repositoryFilesRequest
    this.repositoryFilesLoading = true
    this.repositoryFilesError = null
    this.emit()
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let cursor: string | undefined
        let pageGeneration: number | undefined
        const paths: string[] = []
        const seenPaths = new Set<string>()
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
          for (const path of files.paths) {
            if (seenPaths.has(path)) {
              throw new Error(`Folder file listing returned duplicate path: ${path}`)
            }
            seenPaths.add(path)
            paths.push(path)
          }
          for (const path of files.ignoredPaths ?? []) ignoredPaths.add(path)
          const nextCursor = files.nextCursor
          if (
            nextCursor != null &&
            nextCursor !== '' &&
            (files.paths.length === 0 || nextCursor !== files.paths.at(-1) || nextCursor === cursor)
          ) {
            throw new Error('Folder file listing returned a non-advancing cursor')
          }
          cursor = nextCursor
        } while (cursor != null && cursor !== '')

        if (restart) continue
        if ((pageGeneration ?? 0) < this.repositoryFilesGeneration) return
        this.repositoryFilesGeneration = pageGeneration ?? this.repositoryFilesGeneration
        if (!sameStrings(this.repositoryPaths, paths)) this.repositoryPaths = paths
        if (!sameStringSet(this.repositoryIgnoredPaths, ignoredPaths)) {
          this.repositoryIgnoredPaths = ignoredPaths
        }
        this.repositoryFilesTruncated = false
        markStartup('explorer-ready')
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

  async loadOrdinaryDirectory(
    directory: string,
    refresh = false,
  ): Promise<readonly string[] | null> {
    const key = directory.replace(/\/$/, '')
    if (!refresh) {
      const loaded = this.ordinaryDirectoryChildren.get(key)
      if (loaded != null) return loaded
      const existing = this.ordinaryDirectoryRequests.get(key)
      if (existing != null) return existing
    }
    return this.fetchOrdinaryDirectoryPage(key, undefined, refresh)
  }

  async loadMoreOrdinaryDirectory(directory: string): Promise<readonly string[] | null> {
    const key = directory.replace(/\/$/, '')
    const cursor = this.ordinaryDirectoryCursors.get(key)
    if (cursor == null) return this.ordinaryDirectoryChildren.get(key) ?? []
    const existing = this.ordinaryDirectoryRequests.get(key)
    if (existing != null) return existing
    return this.fetchOrdinaryDirectoryPage(key, cursor, false)
  }

  private fetchOrdinaryDirectoryPage(
    key: string,
    cursor: string | undefined,
    refresh: boolean,
  ): Promise<readonly string[] | null> {
    if (refresh) this.ordinaryDirectoryControllers.get(key)?.abort()
    const controller = new AbortController()
    this.ordinaryDirectoryControllers.set(key, controller)
    const operation = (async (): Promise<readonly string[] | null> => {
      this.repositoryFilesLoading = true
      this.ordinaryDirectoryErrors.delete(key)
      this.emit()
      try {
        const page = await this.api.directoryEntries(key, cursor, controller.signal)
        if (
          controller.signal.aborted ||
          this.ordinaryDirectoryControllers.get(key) !== controller
        ) {
          return null
        }
        if (page.generation < this.repositoryFilesGeneration) return null
        const directoryGeneration = this.ordinaryDirectoryGenerations.get(key)
        if (
          cursor != null &&
          directoryGeneration != null &&
          page.generation !== directoryGeneration
        ) {
          throw new Error('Folder changed while directory was loading')
        }
        if (page.watchCoverage != null) this.ordinaryWatchCoverage = page.watchCoverage
        this.repositoryFilesGeneration = page.generation
        this.ordinaryDirectoryGenerations.set(key, page.generation)
        const pagePaths = page.entries.map((entry) => entry.path)
        const previous = cursor == null ? [] : (this.ordinaryDirectoryChildren.get(key) ?? [])
        const seen = new Set(previous)
        const paths = [...previous]
        for (const path of pagePaths) {
          if (!seen.has(path)) {
            seen.add(path)
            paths.push(path)
          }
        }
        paths.sort()
        this.ordinaryDirectoryChildren.set(key, paths)
        if (page.nextCursor == null || page.nextCursor === '') {
          this.ordinaryDirectoryCursors.delete(key)
          this.ordinaryPagedDirectories.delete(key)
        } else {
          this.ordinaryDirectoryCursors.set(key, page.nextCursor)
          this.ordinaryPagedDirectories.add(key)
        }
        this.rebuildOrdinaryTreePaths()
        this.repositoryFilesError = null
        markStartup('explorer-ready')
        return paths
      } catch (error) {
        if (
          controller.signal.aborted ||
          this.ordinaryDirectoryControllers.get(key) !== controller
        ) {
          return null
        }
        this.ordinaryDirectoryErrors.set(key, errorMessage(error))
        this.repositoryFilesError = errorMessage(error)
        throw error
      } finally {
        if (this.ordinaryDirectoryControllers.get(key) === controller) {
          this.ordinaryDirectoryControllers.delete(key)
          this.ordinaryDirectoryRequests.delete(key)
        }
        this.repositoryFilesLoading = this.ordinaryDirectoryRequests.size > 0
        this.emit()
      }
    })()
    this.ordinaryDirectoryRequests.set(key, operation)
    return operation
  }

  private rebuildOrdinaryTreePaths(): void {
    let removedDirectory = true
    while (removedDirectory) {
      removedDirectory = false
      for (const loaded of this.ordinaryDirectoryChildren.keys()) {
        if (loaded === '') continue
        const separator = loaded.lastIndexOf('/')
        const parent = separator < 0 ? '' : loaded.slice(0, separator)
        const parentChildren = this.ordinaryDirectoryChildren.get(parent)
        if (parentChildren == null || !parentChildren.includes(`${loaded}/`)) {
          this.ordinaryDirectoryControllers.get(loaded)?.abort()
          this.ordinaryDirectoryChildren.delete(loaded)
          this.ordinaryDirectoryControllers.delete(loaded)
          this.ordinaryDirectoryCursors.delete(loaded)
          this.ordinaryDirectoryErrors.delete(loaded)
          this.ordinaryDirectoryGenerations.delete(loaded)
          this.ordinaryDirectoryRequests.delete(loaded)
          this.ordinaryPagedDirectories.delete(loaded)
          removedDirectory = true
        }
      }
    }
    const loadedDirectories = new Set(this.ordinaryDirectoryChildren.keys())
    const allPaths = new Set<string>()
    for (const children of this.ordinaryDirectoryChildren.values()) {
      for (const path of children) allPaths.add(path)
    }
    const unloaded = new Set<string>()
    for (const path of allPaths) {
      if (path.endsWith('/') && !loadedDirectories.has(path.slice(0, -1))) unloaded.add(path)
    }
    this.ordinaryUnloadedDirectories = unloaded
    this.repositoryPaths = [...allPaths].sort()
  }

  async searchOrdinaryFiles(query: string, recentPaths: readonly string[] = []): Promise<void> {
    const request = ++this.ordinarySearchRequest
    this.ordinarySearchController?.abort()
    const controller = new AbortController()
    this.ordinarySearchController = controller
    this.ordinarySearchLoading = true
    this.ordinarySearchError = null
    this.emit()
    try {
      const response = await this.api.searchFiles(query, {
        recentPaths,
        signal: controller.signal,
      })
      if (request !== this.ordinarySearchRequest) return
      if (response.generation < this.generation) {
        this.ordinarySearchResults = []
        this.ordinarySearchComplete = false
        return
      }
      this.ordinarySearchResults = response.results
      this.ordinarySearchComplete = response.complete
    } catch (error) {
      if (controller.signal.aborted || request !== this.ordinarySearchRequest) return
      this.ordinarySearchError = errorMessage(error)
    } finally {
      if (request === this.ordinarySearchRequest) {
        this.ordinarySearchLoading = false
        this.emit()
      }
    }
  }

  async ensureOrdinaryPathLoaded(path: string): Promise<void> {
    if (this.snapshot?.repository !== false) return
    if (!this.ordinaryDirectoryChildren.has('')) await this.loadOrdinaryDirectory('')
    const segments = path.split('/')
    let parent = ''
    for (const segment of segments.slice(0, -1)) {
      const directory = parent === '' ? segment : `${parent}/${segment}`
      const directoryPath = `${directory}/`
      const parentChildren = this.ordinaryDirectoryChildren.get(parent) ?? []
      if (!parentChildren.includes(directoryPath)) {
        this.ordinaryDirectoryChildren.set(parent, [...parentChildren, directoryPath].sort())
        this.rebuildOrdinaryTreePaths()
      }
      if (!this.ordinaryDirectoryChildren.has(directory)) {
        await this.loadOrdinaryDirectory(directory)
      }
      parent = directory
    }
    const parentChildren = this.ordinaryDirectoryChildren.get(parent) ?? []
    if (!parentChildren.includes(path)) {
      this.ordinaryDirectoryChildren.set(parent, [...parentChildren, path].sort())
      this.rebuildOrdinaryTreePaths()
    }
  }

  async openRepositoryFile(path: string, reveal = true): Promise<void> {
    await this.ensureOrdinaryPathLoaded(path)
    if (this.snapshot?.repository === false && !this.repositoryPaths.includes(path)) {
      throw new Error(`File is no longer available: ${path}`)
    }
    this.selectRepositoryFile(path, reveal)
  }

  async refreshExplorer(): Promise<void> {
    if (this.snapshot?.repository !== false) {
      await this.refreshRepositoryFiles()
      return
    }
    // An explicit refresh is authoritative even for unopened directories that
    // are outside partial watch coverage. Restart the server-side Quick Open
    // index before refreshing the stale-but-visible loaded tree.
    await Promise.allSettled([
      this.api.searchFiles('', { refresh: true }),
      this.refreshOrdinaryDirectories(),
    ])
  }

  private async refreshOrdinaryDirectories(): Promise<void> {
    const loadedDirectories =
      this.ordinaryDirectoryChildren.size === 0 ? [''] : [...this.ordinaryDirectoryChildren.keys()]
    const directoriesByDepth = new Map<number, string[]>()
    for (const directory of loadedDirectories) {
      const depth = directory === '' ? 0 : directory.split('/').length
      const directories = directoriesByDepth.get(depth) ?? []
      directories.push(directory)
      directoriesByDepth.set(depth, directories)
    }

    for (const depth of [...directoriesByDepth.keys()].sort((left, right) => left - right)) {
      if (this.snapshot?.repository !== false) return
      const directories = (directoriesByDepth.get(depth) ?? [])
        .filter((directory) => directory === '' || this.ordinaryDirectoryChildren.has(directory))
        .sort((left, right) => left.localeCompare(right))
      let next = 0
      const workerCount = Math.min(4, directories.length)
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const directory = directories[next]
            next += 1
            if (directory == null || this.snapshot?.repository !== false) return
            // A refreshed parent may have removed this loaded subtree. Do not
            // turn its now-obsolete child request into a Repository-wide error.
            if (directory !== '' && !this.ordinaryDirectoryChildren.has(directory)) continue
            try {
              await this.loadOrdinaryDirectory(directory, true)
            } catch {
              // Individual directory errors are retained beside stale children;
              // other loaded directories at this depth still receive their
              // bounded refresh.
            }
          }
        }),
      )
    }
  }

  private async reconcileInitialGenerations(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.snapshot == null || this.error != null || this.repositoryFilesError != null) return
      if (this.generation === this.repositoryFilesGeneration) return
      if (this.generation > this.repositoryFilesGeneration) {
        await this.refreshRepositoryFiles()
      } else {
        await this.refreshSnapshot()
      }
    }
    if (
      this.snapshot != null &&
      this.generation !== this.repositoryFilesGeneration &&
      this.error == null &&
      this.repositoryFilesError == null
    ) {
      this.repositoryPaths = []
      this.repositoryIgnoredPaths = new Set()
      this.repositoryFilesGeneration = 0
      this.repositoryFilesError =
        'Folder changed while initial data was loading. Refresh to try again.'
      this.emit()
    }
  }

  async refreshCurrentFolder(): Promise<void> {
    const folders = this.refreshFolders()
    await this.refreshSnapshot()
    const explorer = this.refreshRepositoryFiles()
    const gitData = this.snapshot?.repository
      ? [this.refreshGraph(), this.refreshBranches(), this.refreshStashes(), this.refreshTags()]
      : []
    await Promise.allSettled([folders, explorer, ...gitData])
    await this.reconcileInitialGenerations()
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
    source.addEventListener('open', () => markStartup('sse-ready'))
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
    const countRequest = ++this.graphCountRequest
    const epoch = this.repositoryEpoch
    this.graphController?.abort()
    this.graphCountController?.abort()
    const controller = new AbortController()
    this.graphController = controller
    this.graphLoading = true
    this.graphError = null
    this.emit()
    try {
      const page = await this.api.graph(0, undefined, controller.signal)
      if (request !== this.graphRequest || epoch !== this.repositoryEpoch) return
      this.graphCommits = page.commits
      this.graphRows = computeGraph(page.commits)
      this.graphHasMore = page.hasMore
      this.graphTip = page.tip
      this.graphGeneration = page.generation
      this.graphTotal =
        page.tip === ''
          ? 0
          : (this.graphCountCache.get(graphCountCacheKey(page.tip, page.generation)) ?? null)
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
      if (page.tip !== '' && this.graphTotal == null) {
        void this.loadGraphCount(page.tip, page.generation, countRequest, epoch)
      }
      markStartup('graph-ready')
    } catch (error) {
      if (
        request === this.graphRequest &&
        epoch === this.repositoryEpoch &&
        !controller.signal.aborted
      ) {
        this.graphError = errorMessage(error)
      }
    } finally {
      if (this.graphController === controller) this.graphController = null
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphLoading = false
        this.emit()
      }
    }
  }

  private async loadGraphCount(
    tip: string,
    generation: number,
    request: number,
    epoch: number,
  ): Promise<void> {
    const cacheKey = graphCountCacheKey(tip, generation)
    const cached = this.graphCountCache.get(cacheKey)
    if (cached != null) {
      this.graphTotal = cached
      this.emit()
      return
    }
    const controller = new AbortController()
    this.graphCountController = controller
    this.graphCountLoading = true
    this.emit()
    try {
      const count = await this.api.graphCount(tip, generation, controller.signal)
      if (
        controller.signal.aborted ||
        request !== this.graphCountRequest ||
        epoch !== this.repositoryEpoch ||
        tip !== this.graphTip ||
        generation !== this.graphGeneration ||
        count.tip !== tip ||
        count.generation !== generation
      ) {
        return
      }
      this.graphCountCache.set(cacheKey, count.total)
      this.graphTotal = count.total
    } catch {
      // Counting is optional metadata; loaded history remains usable and truthful.
    } finally {
      if (this.graphCountController === controller) {
        this.graphCountController = null
        this.graphCountLoading = false
        this.emit()
      }
    }
  }

  async loadMoreGraph(): Promise<void> {
    if (this.graphLoading || !this.graphHasMore || this.graphTip === '') return
    const request = ++this.graphRequest
    const epoch = this.repositoryEpoch
    const skip = this.graphCommits.length
    const tip = this.graphTip
    const generation = this.graphGeneration
    const controller = new AbortController()
    this.graphController = controller
    let refresh = false
    this.graphLoading = true
    this.emit()
    try {
      const page = await this.api.graph(skip, tip, controller.signal)
      if (request !== this.graphRequest || epoch !== this.repositoryEpoch) return
      if (page.tip !== tip || page.generation !== generation) {
        refresh = true
      } else {
        const seen = new Set(this.graphCommits.map((commit) => commit.oid))
        const appended = page.commits.filter((commit) => !seen.has(commit.oid))
        this.graphCommits = [...this.graphCommits, ...appended]
        this.graphRows = appendGraph(this.graphRows, appended)
        this.graphHasMore = page.hasMore
        this.graphError = null
      }
    } catch (error) {
      if (
        request === this.graphRequest &&
        epoch === this.repositoryEpoch &&
        !controller.signal.aborted
      ) {
        if (error instanceof ApiError && error.status === 409) refresh = true
        else this.graphError = errorMessage(error)
      }
    } finally {
      if (this.graphController === controller) this.graphController = null
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphLoading = false
        this.emit()
      }
    }
    if (refresh) await this.refreshGraph()
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
      this.repositoryFileComparisonActive = false
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
    this.repositoryFileComparisonActive = false
    this.emit()
  }

  canOpenRepositoryFile(path: string): boolean {
    if (path.endsWith('/')) return false
    const snapshot = this.snapshot
    const changes =
      snapshot == null
        ? []
        : [...snapshot.staged, ...snapshot.unstaged].filter((change) => change.path === path)
    if (changes.some((change) => change.kind !== 'deleted')) return true
    if (changes.some((change) => change.kind === 'deleted')) return false
    return this.repositoryPaths.includes(path)
  }

  selectRepositoryFile(path: string, reveal = false): void {
    if (!this.canOpenRepositoryFile(path) && !this.repositoryOpenPaths.includes(path)) return
    this.selection = null
    this.commitDiff = null
    this.compareDiff = null
    this.repositoryFileComparisonActive = false
    this.repositoryFilePath = path
    this.repositorySelectedPaths = [path]
    if (!this.repositoryOpenPaths.includes(path)) {
      this.repositoryOpenPaths = [...this.repositoryOpenPaths, path]
    }
    if (reveal) this.repositoryFileRevealVersion += 1
    this.emit()
  }

  setRepositorySelectedPaths(paths: readonly string[]): void {
    const next = [...new Set(paths)]
    if (sameStrings(this.repositorySelectedPaths, next)) return
    this.repositorySelectedPaths = next
    this.emit()
  }

  openRepositoryFileComparison(): void {
    const [leftPath, rightPath, ...remaining] = this.repositorySelectedPaths
    if (
      leftPath == null ||
      rightPath == null ||
      remaining.length > 0 ||
      leftPath === rightPath ||
      leftPath.endsWith('/') ||
      rightPath.endsWith('/') ||
      !this.canOpenRepositoryFile(leftPath) ||
      !this.canOpenRepositoryFile(rightPath)
    ) {
      return
    }
    this.selection = null
    this.commitDiff = null
    this.compare = null
    this.compareFiles = []
    this.compareDiff = null
    this.repositoryFileComparison = { leftPath, rightPath, version: 0 }
    this.repositoryFileComparisonActive = true
    this.emit()
  }

  activateRepositoryFileComparison(): void {
    if (this.repositoryFileComparison == null || this.repositoryFileComparisonActive) return
    this.selection = null
    this.commitDiff = null
    this.compare = null
    this.compareFiles = []
    this.compareDiff = null
    this.repositoryFileComparisonActive = true
    this.emit()
  }

  swapRepositoryFileComparison(): void {
    const comparison = this.repositoryFileComparison
    if (comparison == null) return
    this.repositoryFileComparison = {
      leftPath: comparison.rightPath,
      rightPath: comparison.leftPath,
      version: comparison.version + 1,
    }
    this.repositoryFileComparisonActive = true
    this.repositorySelectedPaths = [comparison.rightPath, comparison.leftPath]
    this.emit()
  }

  closeRepositoryFileComparison(): void {
    if (this.repositoryFileComparison == null) return
    this.repositoryFileComparison = null
    this.repositoryFileComparisonActive = false
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
    this.repositoryFileComparisonActive = false
    this.commitDiff = { oid, subject, ...file }
    this.emit()
  }

  selectCompareFile(file: CommitFile): void {
    if (this.compare == null) return
    this.selection = null
    this.repositoryFilePath = null
    this.commitDiff = null
    this.repositoryFileComparisonActive = false
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
      this.busy = false
      this.activeOp = null
      this.emit()
      if (this.commitDiff != null) await this.refreshGraph()
      await Promise.allSettled([this.refreshSnapshot(), this.refreshRepositoryFiles()])
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
    const selectedPaths = this.repositorySelectedPaths.map(remap)
    const comparison =
      this.repositoryFileComparison == null
        ? null
        : {
            leftPath: remap(this.repositoryFileComparison.leftPath),
            rightPath: remap(this.repositoryFileComparison.rightPath),
            version: this.repositoryFileComparison.version + 1,
          }
    await this.runWorktreeOperation('rename-entry', () =>
      this.api.renameWorktreeEntry(source, destination),
    )
    this.repositoryOpenPaths = openPaths.filter((path) => this.repositoryPaths.includes(path))
    this.repositoryFilePath =
      selectedPath != null && this.repositoryPaths.includes(selectedPath) ? selectedPath : null
    this.repositorySelectedPaths = selectedPaths.filter((path) =>
      path.endsWith('/') ? this.repositoryPaths.includes(path) : this.canOpenRepositoryFile(path),
    )
    this.repositoryFileComparison = comparison
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

  openFolder(path: string, signal?: AbortSignal): Promise<{ root: string; href: string }> {
    return signal == null ? this.api.openFolder(path) : this.api.openFolder(path, signal)
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
