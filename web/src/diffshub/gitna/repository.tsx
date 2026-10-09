import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'

import {
  ApiError,
  createApi,
  type ApiClient,
  type DraftRecord,
  type MutateRequest,
} from '../../lib/api'
import { appendGraph, computeGraph, type GraphRow } from '../../lib/graph-lanes'
import { DocumentStore, type DocumentSnapshot } from './documents'
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
  fromSearch?: boolean
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

type FileMembershipRefresh = 'unknown' | 'unchanged' | 'changed'

export type ReadResult = 'succeeded' | 'failed' | 'obsolete'
type ReconciliationOutcome = {
  result: ReadResult
  failure: string | null
  source: string | null
  sessionError: boolean
  authoritative: boolean
}

function reconciliationOutcome(
  result: ReadResult,
  failure: string | null = null,
  source: string | null = null,
  sessionError = false,
  authoritative = true,
): ReconciliationOutcome {
  return { result, failure, source, sessionError, authoritative }
}

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'reconciling'
  | 'unreachable'
  | 'session-error'

export class ActionGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionGuardError'
  }
}

const RECOVERY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000]
const RECOVERY_OUTAGE_NOTICE = 10_000

function strongerFileMembershipRefresh(
  current: FileMembershipRefresh,
  next: FileMembershipRefresh,
): FileMembershipRefresh {
  if (current === 'changed' || next === 'changed') return 'changed'
  if (current === 'unchanged' || next === 'unchanged') return 'unchanged'
  return 'unknown'
}

type ReconciliationIntent = {
  probeOnly: boolean
  fileMembership: FileMembershipRefresh
  includeExplorer: boolean
  includeGit: boolean
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
  try {
    return new URL(window.location.href).searchParams.get('trace-startup') === '1'
  } catch {
    return false
  }
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
  uncertainMutation: string | null = null
  connectionState: ConnectionState = 'connecting'
  connectionError: string | null = null
  connectionLastSuccessAt: number | null = null
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
  private readonly documents = new DocumentStore()
  private readonly recoverySources = new Map<string, DraftRecord>()

  repositoryPaths: string[] = []
  repositoryIgnoredPaths = new Set<string>()
  repositoryFilesLoading = false
  repositoryFilesError: string | null = null
  repositoryFilesTruncated = false
  repositoryFileTotal: number | null = null
  repositoryFileTotalGeneration = 0
  repositoryFileCountLoading = false
  ordinaryUnloadedDirectories = new Set<string>()
  ordinaryKnownEmptyDirectories = new Set<string>()
  ordinaryPagedDirectories = new Set<string>()
  ordinaryDirectoryErrors = new Map<string, string>()
  ordinaryWatchCoverage: 'complete' | 'partial' = 'complete'
  ordinarySearchResults: FileSearchResult[] = []
  ordinarySearchResultQuery: string | null = null
  ordinarySearchResultIncludeIgnored = false
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
  graphReveal: { oid: string } | null = null
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
  remotes: string[] = []
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
  private refreshPromise: Promise<ReconciliationOutcome> | null = null
  private refreshAgain = false
  private pendingFileMembershipRefresh: FileMembershipRefresh = 'unknown'
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private repositoryEpoch = 0
  private initialRefreshStarted = false
  private initialRefreshPromise: Promise<ReconciliationOutcome> | null = null
  private initialRefreshResult: ReconciliationOutcome | null = null
  private sourceOpen = false
  private sourceHasOpened = false
  private readinessEpoch: number | null = null
  private graphInvalidation: Promise<ReconciliationOutcome> | null = null
  private reconciliationPromise: Promise<ReconciliationOutcome> | null = null
  private reconciliationEpoch = 0
  private unresolvedReconciliationFailure: string | null = null
  private pendingReconciliation: ReconciliationIntent | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryStartedAt: number | null = null
  private recoveryNoticeAt: number | null = null
  private recoveryNoticeDelivered = false
  private recoveryTransportLost = false
  private recoveryAttempt = 0
  private retryDueAt: number | null = null
  private disposed = false
  private folderRequest = 0
  private graphRequest = 0
  private graphCountRequest = 0
  private graphController: AbortController | null = null
  private graphCountController: AbortController | null = null
  private graphCountCache = new Map<string, number>()
  private branchesRequest = 0
  private stashesRequest = 0
  private tagsRequest = 0
  private gitDetailEpoch = 0
  private compareRequest = 0
  private conflictsRequest = 0
  private repositoryFilesGeneration = 0
  private repositoryFileCountRequest = 0
  private repositoryFileCountController: AbortController | null = null

  constructor(
    api: ApiClient = createApi(),
    private readonly eventsURL = 'api/v1/events',
  ) {
    this.api = api
  }

  get activeOpLabel(): string | null {
    return this.activeOp == null ? null : (OP_LABELS[this.activeOp] ?? this.activeOp)
  }

  acknowledgeUncertainMutation(): void {
    if (this.uncertainMutation == null) return
    this.uncertainMutation = null
    this.emit()
  }

  private recordUncertainMutation(label: string, error: unknown): void {
    if (error instanceof ApiError) return
    this.uncertainMutation = `${label} outcome is unknown. Gitna could not confirm whether the backend completed it. Inspect the repository before repeating the action.`
    this.emit()
  }

  get connectionReady(): boolean {
    return this.connectionState === 'connected'
  }

  getActionDisabledReason(policy: 'backend' | 'open-folder' = 'backend'): string | null {
    if (this.disposed) return 'This repository view is closed. Reopen Gitna to continue.'
    if (this.busy) {
      const label = this.activeOpLabel
      return label == null
        ? 'Another operation is in progress. Wait for it to finish.'
        : `Another operation is in progress (${label}). Wait for it to finish.`
    }
    if (policy === 'open-folder') return null
    switch (this.connectionState) {
      case 'connected':
        return null
      case 'connecting':
        return 'Connecting to backend. Wait for connection and refresh to complete.'
      case 'reconnecting':
        return 'Backend connection interrupted. Wait for reconnection or refresh to retry.'
      case 'reconciling':
        return `Refreshing backend state. Wait for refresh to complete.${
          this.connectionError == null ? '' : ` ${this.connectionError} Refresh to retry.`
        }`
      case 'unreachable':
        return 'Backend unreachable. Retry the connection or reopen Gitna.'
      case 'session-error':
        return `Backend session error. Reopen Gitna using its current URL.${
          this.connectionError == null ? '' : ` ${this.connectionError}`
        }`
    }
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

  async refreshSnapshot(fileMembership: FileMembershipRefresh = 'unknown'): Promise<ReadResult> {
    return (await this.readSnapshot(fileMembership)).result
  }

  private async readSnapshot(
    fileMembership: FileMembershipRefresh = 'unknown',
  ): Promise<ReconciliationOutcome> {
    this.refreshAgain = true
    this.pendingFileMembershipRefresh = strongerFileMembershipRefresh(
      this.pendingFileMembershipRefresh,
      fileMembership,
    )
    if (this.refreshPromise != null) return this.refreshPromise

    const operationEpoch = this.repositoryEpoch
    const operation = (async (): Promise<ReconciliationOutcome> => {
      let result = reconciliationOutcome('obsolete')
      while (this.refreshAgain) {
        if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
        this.refreshAgain = false
        const requestedFileMembershipRefresh = this.pendingFileMembershipRefresh
        this.pendingFileMembershipRefresh = 'unknown'
        this.loading = true
        this.error = null
        this.emit()
        const epoch = this.repositoryEpoch
        try {
          const next = await this.api.snapshot()
          if (epoch !== this.repositoryEpoch || operationEpoch !== this.repositoryEpoch) {
            return reconciliationOutcome('obsolete')
          }
          if (next.generation < this.generation) {
            result = reconciliationOutcome('obsolete')
            continue
          }
          const previousGeneration = this.generation
          if (next.generation > this.generation) {
            this.generation = next.generation
            this.snapshot = next
            const effectiveFileMembershipRefresh = strongerFileMembershipRefresh(
              requestedFileMembershipRefresh,
              this.pendingFileMembershipRefresh,
            )
            if (
              effectiveFileMembershipRefresh === 'unchanged' &&
              this.repositoryFileTotalGeneration === previousGeneration
            ) {
              this.repositoryFileTotalGeneration = next.generation
            }
            this.selection = reconcileSelection(this.selection, next.staged, next.unstaged)
            this.conflictsRequest += 1
            this.conflictsLoading = false
            this.conflictsError = null
            this.conflicts =
              next.operation === 'merge' ||
              next.operation === 'rebase' ||
              next.operation === 'cherry-pick' ||
              next.operation === 'revert'
                ? (next.conflicts ?? [])
                : []
          }
          this.pendingFileMembershipRefresh = 'unknown'
          this.error = null
          if (next.repository !== true) this.clearGitState()
          result = reconciliationOutcome('succeeded')
          markStartup('snapshot-ready')
          markStartup('source-control-ready')
        } catch (error) {
          if (epoch === this.repositoryEpoch && operationEpoch === this.repositoryEpoch) {
            this.error = errorMessage(error)
            result = reconciliationOutcome(
              'failed',
              errorMessage(error),
              'snapshot',
              error instanceof ApiError && (error.status === 403 || error.status === 404),
            )
          } else return reconciliationOutcome('obsolete')
        } finally {
          if (epoch === this.repositoryEpoch && operationEpoch === this.repositoryEpoch) {
            this.loading = false
            this.emit()
          }
        }
      }
      return result
    })()
    this.refreshPromise = operation

    try {
      return await operation
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = null
    }
  }

  async refreshFolders(operationEpoch = this.repositoryEpoch): Promise<void> {
    const request = ++this.folderRequest
    this.foldersLoading = true
    this.foldersError = null
    this.emit()
    try {
      const folders = await this.api.folders()
      if (request !== this.folderRequest || operationEpoch !== this.repositoryEpoch) return
      this.folders = folders
    } catch (error) {
      if (request === this.folderRequest && operationEpoch === this.repositoryEpoch)
        this.foldersError = errorMessage(error)
    } finally {
      if (request === this.folderRequest && operationEpoch === this.repositoryEpoch) {
        this.foldersLoading = false
        this.emit()
      }
    }
  }

  async refreshRepositoryFiles(operationEpoch = this.repositoryEpoch): Promise<ReadResult> {
    return (await this.readRepositoryFiles(operationEpoch)).result
  }

  private async readRepositoryFiles(
    operationEpoch = this.repositoryEpoch,
  ): Promise<ReconciliationOutcome> {
    // Defer the exact count only for the owned initial load. Recovery still
    // waits for authoritative count/generation catch-up before enabling actions.
    const count = this.refreshRepositoryFileCount()
    const [directories] = await Promise.all([
      this.refreshOrdinaryDirectories(operationEpoch),
      this.initialRefreshPromise != null ? undefined : count,
    ])
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
    if (directories.result !== 'succeeded') return directories
    return reconciliationOutcome('succeeded')
  }

  async refreshRepositoryFileCount(): Promise<void> {
    if (this.snapshot?.repository !== true) {
      this.repositoryFileTotal = null
      this.repositoryFileTotalGeneration = 0
      return
    }
    const request = ++this.repositoryFileCountRequest
    this.repositoryFileCountController?.abort()
    const controller = new AbortController()
    this.repositoryFileCountController = controller
    this.repositoryFileCountLoading = true
    this.emit()
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const generation = this.generation
          const count = await this.api.repositoryFileCount(generation, controller.signal)
          if (request !== this.repositoryFileCountRequest || controller.signal.aborted) return
          if (count.generation !== generation || count.generation < this.generation) continue
          this.repositoryFileTotal = count.total
          this.repositoryFileTotalGeneration = count.generation
          return
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.status !== 409 ||
            attempt === 2 ||
            controller.signal.aborted
          ) {
            throw error
          }
          await this.refreshSnapshot()
          if (request !== this.repositoryFileCountRequest || controller.signal.aborted) return
        }
      }
    } catch {
      // Keep the last exact count visible when a refresh is interrupted.
    } finally {
      if (request === this.repositoryFileCountRequest) {
        this.repositoryFileCountLoading = false
        this.emit()
      }
    }
  }

  async loadOrdinaryDirectory(
    directory: string,
    refresh = false,
    operationEpoch = this.repositoryEpoch,
  ): Promise<readonly string[] | null> {
    if (operationEpoch !== this.repositoryEpoch) return null
    const key = directory.replace(/\/$/, '')
    const existing = this.ordinaryDirectoryRequests.get(key)
    if (!refresh) {
      const loaded = this.ordinaryDirectoryChildren.get(key)
      if (loaded != null) return loaded
      if (existing != null) return existing
    } else if (existing != null) {
      try {
        await existing
      } catch {
        // A requested refresh supersedes the failed in-flight listing.
      }
      if (operationEpoch !== this.repositoryEpoch) return null
      const refreshing = this.ordinaryDirectoryRequests.get(key)
      if (refreshing != null) return refreshing
    }
    return this.fetchOrdinaryDirectoryPage(key, undefined)
  }

  async loadMoreOrdinaryDirectory(directory: string): Promise<readonly string[] | null> {
    const key = directory.replace(/\/$/, '')
    const cursor = this.ordinaryDirectoryCursors.get(key)
    if (cursor == null) return this.ordinaryDirectoryChildren.get(key) ?? []
    const existing = this.ordinaryDirectoryRequests.get(key)
    if (existing != null) return existing
    return this.fetchOrdinaryDirectoryPage(key, cursor)
  }

  private fetchOrdinaryDirectoryPage(
    key: string,
    cursor: string | undefined,
  ): Promise<readonly string[] | null> {
    const epoch = this.repositoryEpoch
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
        if (cursor == null) {
          for (const path of this.ordinaryDirectoryChildren.get(key) ?? []) {
            this.repositoryIgnoredPaths.delete(path)
            this.ordinaryKnownEmptyDirectories.delete(path)
          }
        }
        for (const entry of page.entries) {
          if (entry.ignored === true) this.repositoryIgnoredPaths.add(entry.path)
          else this.repositoryIgnoredPaths.delete(entry.path)
          if (entry.kind === 'directory' && entry.hasChildren === false) {
            this.ordinaryKnownEmptyDirectories.add(entry.path)
          } else {
            this.ordinaryKnownEmptyDirectories.delete(entry.path)
          }
        }
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
          if (epoch === this.repositoryEpoch) {
            this.repositoryFilesLoading = this.ordinaryDirectoryRequests.size > 0
            this.emit()
          }
        }
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
      if (
        path.endsWith('/') &&
        !loadedDirectories.has(path.slice(0, -1)) &&
        !this.ordinaryKnownEmptyDirectories.has(path)
      ) {
        unloaded.add(path)
      }
    }
    this.ordinaryUnloadedDirectories = unloaded
    this.ordinaryKnownEmptyDirectories = new Set(
      [...this.ordinaryKnownEmptyDirectories].filter((path) => allPaths.has(path)),
    )
    this.repositoryIgnoredPaths = new Set(
      [...this.repositoryIgnoredPaths].filter((path) => allPaths.has(path)),
    )
    this.repositoryPaths = [...allPaths].sort()
  }

  async searchOrdinaryFiles(
    query: string,
    recentPaths: readonly string[] = [],
    includeIgnored = false,
  ): Promise<void> {
    const request = ++this.ordinarySearchRequest
    this.ordinarySearchController?.abort()
    const controller = new AbortController()
    this.ordinarySearchController = controller
    this.ordinarySearchLoading = true
    this.ordinarySearchError = null
    this.emit()
    try {
      const response = await this.api.searchFiles(query, {
        includeIgnored,
        recentPaths,
        signal: controller.signal,
      })
      if (request !== this.ordinarySearchRequest) return
      if (response.generation < this.generation) {
        this.ordinarySearchResults = []
        this.ordinarySearchResultQuery = query
        this.ordinarySearchResultIncludeIgnored = includeIgnored
        this.ordinarySearchComplete = false
        return
      }
      this.ordinarySearchResults = response.results
      this.ordinarySearchResultQuery = query
      this.ordinarySearchResultIncludeIgnored = includeIgnored
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

  private async ensureDirectoryContains(parent: string, target: string): Promise<boolean> {
    if (!this.ordinaryDirectoryChildren.has(parent)) {
      const loaded = await this.loadOrdinaryDirectory(parent)
      if (loaded == null) return false
    }
    while (!(this.ordinaryDirectoryChildren.get(parent) ?? []).includes(target)) {
      if (!this.ordinaryDirectoryCursors.has(parent)) return false
      const loaded = await this.loadMoreOrdinaryDirectory(parent)
      if (loaded == null) return false
    }
    return true
  }

  async ensureOrdinaryPathLoaded(path: string): Promise<void> {
    const segments = path.split('/')
    let parent = ''
    for (const [index, segment] of segments.entries()) {
      const child = parent === '' ? segment : `${parent}/${segment}`
      const directory = index < segments.length - 1
      const target = directory ? `${child}/` : child
      if (!(await this.ensureDirectoryContains(parent, target))) {
        throw new Error(`File is no longer available: ${path}`)
      }
      if (directory) parent = child
    }
  }

  isUntitledPath(path: string): boolean {
    return path.startsWith('untitled:')
  }

  untitledDocument(path: string): DocumentSnapshot | null {
    if (!this.isUntitledPath(path)) return null
    return this.documents.get(path.slice('untitled:'.length))
  }

  untitledDocuments(): readonly DocumentSnapshot[] {
    return this.documents.list().filter((document) => document.path == null)
  }

  documentForPath(path: string): DocumentSnapshot | null {
    return this.documents.findByPath(path)
  }

  updateUntitledContent(path: string, contents: string): DocumentSnapshot | null {
    const document = this.untitledDocument(path)
    if (document == null) return null
    const updated = this.documents.updateContent(document.id, contents)
    this.emit()
    return updated
  }

  createUntitledDocument(): string {
    const document = this.documents.createUntitled('', this.snapshot?.root)
    const path = `untitled:${document.id}`
    this.selectRepositoryFile(path, true)
    return path
  }

  async restoreDraft(record: DraftRecord): Promise<string> {
    let suffix = ' (Recovered)'
    if (record.path != null && this.api.readWorktreeFile != null) {
      try {
        const current = await this.api.readWorktreeFile(record.path)
        if (record.baselineHash != null && current.hash !== record.baselineHash) {
          suffix = ' (Conflict — disk changed)'
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'file-not-found') {
          suffix = ' (Recovered — file missing)'
        }
      }
    }
    const document = this.documents.createUntitled(
      record.contents,
      record.folderKey,
      `${record.label}${suffix}`,
    )
    this.recoverySources.set(document.id, record)
    const path = `untitled:${document.id}`
    this.selectRepositoryFile(path, true)
    this.emit()
    return path
  }

  async discardUntitledDocument(path: string): Promise<void> {
    const document = this.untitledDocument(path)
    if (document == null) return
    const source = this.recoverySources.get(document.id)
    const documentID = source?.documentId ?? document.id
    const revision = source?.revision ?? document.revision
    if (this.api.deleteDraft != null) {
      try {
        await this.api.deleteDraft(documentID, revision)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          // The backup may already have been acknowledged and cleaned up.
        } else if (error instanceof ApiError && error.status === 409 && this.api.drafts != null) {
          const current = (await this.api.drafts()).find(
            (candidate) => candidate.documentId === documentID,
          )
          if (current == null) throw error
          await this.api.deleteDraft(documentID, current.revision)
        } else {
          throw error
        }
      }
      this.recoverySources.delete(document.id)
    }
    this.closeRepositoryFiles([path])
  }

  async saveUntitledDocument(path: string, destination: string): Promise<WorktreeFile> {
    const document = this.untitledDocument(path)
    if (document == null) throw new Error('This untitled document is no longer available.')
    const submittedRevision = document.revision
    const submittedContents = document.contents
    const saved = await this.runWorktreeOperation('save-file', () =>
      this.api.createWorktreeFile(destination, submittedContents),
    )
    const acknowledged = this.documents.acknowledgeSave(
      document.id,
      submittedRevision,
      submittedContents,
      {
        path: destination,
        baselineHash: saved.hash,
      },
    )
    const recoverySource = this.recoverySources.get(document.id)
    if (!acknowledged.dirty && this.api.deleteDraft != null) {
      const backups = [
        {
          documentId: recoverySource?.documentId ?? document.id,
          revision: recoverySource?.revision ?? submittedRevision,
        },
      ]
      if (recoverySource != null && recoverySource.documentId !== document.id) {
        backups.push({ documentId: document.id, revision: submittedRevision })
      }
      try {
        for (const backup of backups) {
          try {
            await this.api.deleteDraft(backup.documentId, backup.revision)
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error
          }
        }
        this.recoverySources.delete(document.id)
      } catch (error) {
        this.mutationError = `Saved ${destination}, but could not remove its recovery backup: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    this.repositoryOpenPaths = this.repositoryOpenPaths.map((openPath) =>
      openPath === path ? destination : openPath,
    )
    this.repositoryFilePath =
      this.repositoryFilePath === path ? destination : this.repositoryFilePath
    this.repositorySelectedPaths = this.repositorySelectedPaths.map((selectedPath) =>
      selectedPath === path ? destination : selectedPath,
    )
    this.emit()
    return saved
  }

  async openRepositoryFile(path: string, reveal = true): Promise<void> {
    await this.ensureOrdinaryPathLoaded(path)
    if (!this.repositoryPaths.includes(path)) {
      throw new Error(`File is no longer available: ${path}`)
    }
    this.selectRepositoryFile(path, reveal)
  }

  async refreshExplorer(): Promise<void> {
    // An explicit refresh is authoritative even for unopened directories that
    // are outside partial watch coverage. Restart the server-side Quick Open
    // index before refreshing the stale-but-visible loaded tree.
    // Resetting search also invalidates the directory index. Let that finish
    // before listing directories, otherwise the reset can cancel our own refresh.
    await Promise.allSettled([this.api.searchFiles('', { refresh: true })])
    await this.refreshRepositoryFiles()
  }

  private async refreshOrdinaryDirectories(
    operationEpoch = this.repositoryEpoch,
  ): Promise<ReconciliationOutcome> {
    const loadedDirectories =
      this.ordinaryDirectoryChildren.size === 0 ? [''] : [...this.ordinaryDirectoryChildren.keys()]
    const directoriesByDepth = new Map<number, string[]>()
    let result = reconciliationOutcome('succeeded')
    for (const directory of loadedDirectories) {
      const depth = directory === '' ? 0 : directory.split('/').length
      const directories = directoriesByDepth.get(depth) ?? []
      directories.push(directory)
      directoriesByDepth.set(depth, directories)
    }

    for (const depth of [...directoriesByDepth.keys()].sort((left, right) => left - right)) {
      if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
      const directories = (directoriesByDepth.get(depth) ?? [])
        .filter((directory) => directory === '' || this.ordinaryDirectoryChildren.has(directory))
        .sort((left, right) => left.localeCompare(right))
      let next = 0
      const workerCount = Math.min(4, directories.length)
      const refreshDirectoryWorker = async (): Promise<void> => {
        for (;;) {
          const directory = directories[next]
          next += 1
          if (directory == null) return
          // A refreshed parent may have removed this loaded subtree. Do not
          // turn its now-obsolete child request into a Repository-wide error.
          if (directory !== '' && !this.ordinaryDirectoryChildren.has(directory)) continue
          try {
            const refreshed = await this.loadOrdinaryDirectory(directory, true, operationEpoch)
            if (operationEpoch !== this.repositoryEpoch) return
            if (
              refreshed == null &&
              (directory === '' || this.ordinaryDirectoryChildren.has(directory)) &&
              result.result !== 'failed'
            ) {
              result = reconciliationOutcome('obsolete')
            }
          } catch (error) {
            if (operationEpoch !== this.repositoryEpoch) return
            // Individual directory errors remain authoritative failures even
            // when another loaded directory refreshes successfully.
            result = reconciliationOutcome('failed', errorMessage(error), `directory:${directory}`)
          }
        }
      }
      await Promise.all(Array.from({ length: workerCount }, refreshDirectoryWorker))
    }
    return result
  }

  private async reconcileInitialGenerations(
    operationEpoch = this.repositoryEpoch,
  ): Promise<ReconciliationOutcome> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
      if (this.snapshot == null) return reconciliationOutcome('obsolete')
      if (this.generation === this.repositoryFilesGeneration)
        return reconciliationOutcome('succeeded')
      if (this.generation > this.repositoryFilesGeneration) {
        const result = await this.readRepositoryFiles(operationEpoch)
        if (result.result !== 'succeeded') return result
      } else {
        const result = await this.readSnapshot()
        if (result.result !== 'succeeded') return result
      }
    }
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
    if (this.snapshot != null && this.generation !== this.repositoryFilesGeneration) {
      this.repositoryFilesError =
        'Folder changed while initial data was loading. Refresh to try again.'
      this.emit()
      return reconciliationOutcome('failed', this.repositoryFilesError, 'generation')
    }
    return reconciliationOutcome('succeeded')
  }

  private setConnectionState(state: ConnectionState, error: string | null = null): void {
    this.connectionState = state
    this.connectionError = error
    this.emit()
  }

  private invalidateReadWork(): void {
    this.repositoryEpoch += 1
    this.readinessEpoch = null
    this.graphInvalidation = null
    this.refreshAgain = false
    this.pendingFileMembershipRefresh = 'unknown'
    this.refreshPromise = null
    this.initialRefreshResult = null
    this.initialRefreshPromise = null
    this.folderRequest += 1
    this.foldersLoading = false
    this.foldersError = null
    this.loading = false
    this.error = null
    this.invalidateGitLoading()
    this.repositoryFilesLoading = false
    this.repositoryFilesError = null
    this.ordinaryDirectoryErrors.clear()
    this.repositoryFileCountLoading = false
    this.ordinarySearchRequest += 1
    this.ordinarySearchLoading = false
    this.ordinarySearchError = null
    this.graphRequest += 1
    this.graphCountRequest += 1
    this.branchesRequest += 1
    this.stashesRequest += 1
    this.tagsRequest += 1
    this.repositoryFileCountRequest += 1
    this.graphController?.abort()
    this.graphCountController?.abort()
    this.repositoryFileCountController?.abort()
    for (const controller of this.ordinaryDirectoryControllers.values()) controller.abort()
    this.ordinarySearchController?.abort()
  }

  private invalidateGitLoading(): void {
    this.gitDetailEpoch += 1
    this.compareRequest += 1
    this.conflictsRequest += 1
    this.filesLoading = {}
    this.filesError = {}
    this.graphLoading = false
    this.graphCountLoading = false
    this.branchesLoading = false
    this.stashesLoading = false
    this.tagsLoading = false
    this.compareLoading = false
    this.conflictsLoading = false
    this.graphError = null
    this.branchesError = null
    this.stashesError = null
    this.tagsError = null
    this.compareError = null
    this.conflictsError = null
  }

  private clearGitState(): void {
    this.invalidateGitLoading()
    this.graphGeneration = 0
    this.graphCountCache.clear()
    this.repositoryFileCountRequest += 1
    this.repositoryFileCountController?.abort()
    this.repositoryFileCountLoading = false
    this.repositoryFileTotal = null
    this.repositoryFileTotalGeneration = 0
    this.expanded = {}
    this.commitFiles = {}
    this.commitStats = {}
    this.commitDiff = null
    this.compare = null
    this.compareFiles = []
    this.compareDiff = null
    this.selection = null
    this.graphRequest += 1
    this.graphCountRequest += 1
    this.branchesRequest += 1
    this.stashesRequest += 1
    this.tagsRequest += 1
    this.graphController?.abort()
    this.graphCountController?.abort()
    this.graphCommits = []
    this.graphRows = []
    this.graphReveal = null
    this.graphError = null
    this.graphHasMore = false
    this.graphTip = ''
    this.graphTotal = null
    this.branches = []
    this.remotes = []
    this.branchesError = null
    this.stashes = []
    this.stashesError = null
    this.tags = []
    this.tagsError = null
    this.conflicts = []
    this.conflictsError = null
  }

  private async performReconciliation(
    operationEpoch: number,
    intent: ReconciliationIntent,
  ): Promise<ReconciliationOutcome> {
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
    if (!this.sourceOpen || !this.connectionReady) {
      this.setConnectionState(
        this.sourceOpen
          ? 'reconciling'
          : this.recoveryNoticeDelivered
            ? 'unreachable'
            : this.sourceHasOpened
              ? 'reconnecting'
              : 'connecting',
        this.sourceOpen || this.recoveryNoticeDelivered ? this.connectionError : null,
      )
    }
    const previousRepository = this.snapshot?.repository
    const snapshotResult = await this.readSnapshot(intent.fileMembership)
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
    if (snapshotResult.result !== 'succeeded') {
      if (!intent.probeOnly) this.readinessEpoch = null
      return snapshotResult
    }
    if (intent.probeOnly) return reconciliationOutcome('succeeded', null, null, false, false)

    const capabilityChanged =
      previousRepository != null && previousRepository !== this.snapshot?.repository
    if (capabilityChanged) this.setConnectionState('reconciling', null)
    const includeExplorer = intent.includeExplorer || capabilityChanged
    const includeGit = intent.includeGit || capabilityChanged
    const gitEpoch = this.gitDetailEpoch
    const loadedGit = includeGit && this.snapshot?.repository === true
    const gitReads = () =>
      Promise.all([this.readGraph(), this.readBranches(), this.readStashes(), this.readTags()])
    // Explorer and Git are independent after Snapshot. The initial count loads
    // in the background; recovery retains bounded count/generation catch-up.
    const invalidatedGraph = this.graphInvalidation
    if (loadedGit) this.graphInvalidation = null
    const [explorer, git, graphInvalidation] = await Promise.all([
      includeExplorer
        ? this.readRepositoryFiles(operationEpoch)
        : reconciliationOutcome('succeeded'),
      loadedGit ? gitReads() : [],
      loadedGit ? null : invalidatedGraph,
    ])
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
    const generation =
      includeExplorer && explorer.result === 'succeeded'
        ? await this.reconcileInitialGenerations(operationEpoch)
        : explorer
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')

    // Snapshot/count reconciliation can change capability after the first
    // fan-out. Git outcomes invalidated by capability loss no longer apply.
    const resultingGit = this.snapshot?.repository === true
    const gitResults = resultingGit
      ? (!loadedGit && (includeGit || previousRepository !== true)) ||
        (loadedGit && gitEpoch !== this.gitDetailEpoch)
        ? await gitReads()
        : git
      : []
    if (operationEpoch !== this.repositoryEpoch) return reconciliationOutcome('obsolete')
    if (this.graphInvalidation === invalidatedGraph) this.graphInvalidation = null
    const results = [
      explorer,
      generation,
      ...gitResults,
      ...(resultingGit && graphInvalidation != null ? [graphInvalidation] : []),
    ]
    const unsuccessful =
      results.find((outcome) => outcome.result === 'failed') ??
      results.find((outcome) => outcome.result === 'obsolete')
    if (unsuccessful != null) {
      this.readinessEpoch = null
      return unsuccessful
    }
    if (includeExplorer && includeGit) this.readinessEpoch = operationEpoch
    return reconciliationOutcome(
      'succeeded',
      null,
      null,
      false,
      this.readinessEpoch === operationEpoch,
    )
  }

  private finishReconciliation(outcome: ReconciliationOutcome): void {
    // Keep the captured reason across partial catch-up; loader error stores may
    // already have changed without recovering the failed authoritative scope.
    if (outcome.result === 'failed') this.unresolvedReconciliationFailure = outcome.failure
    else if (outcome.result === 'succeeded' && outcome.authoritative)
      this.unresolvedReconciliationFailure = null
    const failure = this.unresolvedReconciliationFailure
    if (outcome.result === 'succeeded' && outcome.authoritative && this.sourceOpen) {
      this.connectionLastSuccessAt = Date.now()
      this.recoveryStartedAt = null
      this.recoveryNoticeAt = null
      this.recoveryNoticeDelivered = false
      this.recoveryTransportLost = false
      this.recoveryAttempt = 0
      this.retryDueAt = null
      if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
      this.setConnectionState('connected', null)
    } else if (outcome.result === 'failed' && outcome.sessionError) {
      this.setConnectionState('session-error', outcome.failure)
    } else if (this.sourceOpen) {
      this.setConnectionState('reconciling', failure)
    } else if (!this.recoveryNoticeDelivered) {
      this.setConnectionState(this.sourceHasOpened ? 'reconnecting' : 'connecting', failure)
    }
  }

  private startReconciliation(
    probeOnly = false,
    fileMembership: FileMembershipRefresh = 'unknown',
    includeExplorer = true,
    includeGit = true,
  ): Promise<ReconciliationOutcome> {
    const intent = { probeOnly, fileMembership, includeExplorer, includeGit }
    if (this.reconciliationPromise != null) {
      const pending = this.pendingReconciliation
      this.pendingReconciliation =
        pending == null
          ? intent
          : {
              probeOnly: pending.probeOnly && probeOnly,
              fileMembership: strongerFileMembershipRefresh(pending.fileMembership, fileMembership),
              includeExplorer: pending.includeExplorer || includeExplorer,
              includeGit: pending.includeGit || includeGit,
            }
      // Structural intent must reach the pending Snapshot before it decides
      // whether the old exact count may be carried to a new generation.
      if (this.refreshPromise != null) {
        this.pendingFileMembershipRefresh = strongerFileMembershipRefresh(
          this.pendingFileMembershipRefresh,
          fileMembership,
        )
      }
      return this.reconciliationPromise
    }
    const owner = this.eventSource
    const lifecycle = this.reconciliationEpoch
    let settledReadEpoch = this.repositoryEpoch
    const run = async (): Promise<ReconciliationOutcome> => {
      let next: ReconciliationIntent | null = intent
      let outcome = reconciliationOutcome('succeeded')
      while (next != null) {
        if (lifecycle !== this.reconciliationEpoch) return reconciliationOutcome('obsolete')
        this.pendingReconciliation = null
        settledReadEpoch = this.repositoryEpoch
        const current = await this.performReconciliation(settledReadEpoch, next)
        if (lifecycle !== this.reconciliationEpoch) return reconciliationOutcome('obsolete')
        // A partial follow-up cannot erase an unmet authoritative loader.
        if (
          current.result !== 'succeeded' ||
          (next.includeExplorer && next.includeGit && !next.probeOnly) ||
          outcome.result === 'succeeded'
        ) {
          outcome = current
        }
        // Event handlers can accumulate intent while the read is awaited.
        next = this.pendingReconciliation as ReconciliationIntent | null
        if (next != null && !this.sourceOpen) next = { ...next, probeOnly: true }
      }
      return outcome
    }
    const operation = run().then((outcome) => {
      if (this.reconciliationPromise !== operation) return reconciliationOutcome('obsolete')
      // Release the owned slot before exposing completion to callers (not in
      // a detached finally). CLOSED replacement must inherit a settled deadline.
      this.reconciliationPromise = null
      if (lifecycle !== this.reconciliationEpoch || (owner != null && this.eventSource !== owner)) {
        return reconciliationOutcome('obsolete')
      }
      if (settledReadEpoch !== this.repositoryEpoch) outcome = reconciliationOutcome('obsolete')
      this.finishReconciliation(outcome)
      if (
        this.connectionState !== 'connected' &&
        (outcome.result !== 'succeeded' || !outcome.authoritative || this.recoveryTransportLost)
      ) {
        this.retryDueAt = null
        this.scheduleRecovery(true)
      }
      return outcome
    })
    this.reconciliationPromise = operation
    return operation
  }

  private scheduleRecovery(force = false): void {
    if (this.disposed || this.eventSource == null || this.connectionState === 'connected') return
    const now = Date.now()
    this.recoveryStartedAt ??= now
    if (force && this.recoveryTimer != null) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }

    // A retry deadline belongs to one probe. Do not replace it when a notice
    // wake or a second caller merely asks to keep recovery alive.
    if (this.retryDueAt == null && this.reconciliationPromise == null) {
      const base = RECOVERY_DELAYS[Math.min(this.recoveryAttempt, RECOVERY_DELAYS.length - 1)]!
      const jitter = Math.min(base * (0.8 + Math.random() * 0.4), RECOVERY_DELAYS.at(-1)!)
      this.retryDueAt = now + jitter
    }
    if (this.recoveryTimer != null) return
    const noticeAt =
      this.recoveryTransportLost && !this.sourceOpen && !this.recoveryNoticeDelivered
        ? this.recoveryNoticeAt
        : null
    const retryAt = this.reconciliationPromise == null ? this.retryDueAt : null
    const due = Math.min(retryAt ?? Infinity, noticeAt ?? Infinity)
    if (!Number.isFinite(due)) return
    const owner = this.eventSource
    const ownerEpoch = this.reconciliationEpoch
    this.recoveryTimer = setTimeout(
      () => {
        this.recoveryTimer = null
        if (this.eventSource !== owner || this.reconciliationEpoch !== ownerEpoch) return
        const currentTime = Date.now()
        const notifyOutage =
          noticeAt != null &&
          currentTime >= noticeAt &&
          !this.sourceOpen &&
          !this.recoveryNoticeDelivered
        if (notifyOutage) {
          this.recoveryNoticeDelivered = true
          this.setConnectionState('unreachable', this.connectionError ?? 'Backend unreachable')
        }
        if (this.reconciliationPromise != null) {
          this.scheduleRecovery()
          return
        }
        if (this.retryDueAt == null || currentTime < this.retryDueAt) {
          this.scheduleRecovery()
          return
        }

        // Consume this deadline only when its probe actually starts. The next
        // deadline is assigned by the settled operation, not by its start.
        this.retryDueAt = null
        this.recoveryAttempt += 1
        const source = this.eventSource
        const sourceEpoch = this.reconciliationEpoch
        void this.startReconciliation(!this.sourceOpen).then((outcome) => {
          if (this.eventSource !== source || this.reconciliationEpoch !== sourceEpoch) return
          if (outcome.result === 'succeeded' && source != null && source.readyState === 2) {
            // This is an internal replacement in the same outage. Keep the
            // recovery state, but let the new source own future callbacks.
            this.disposeConnection(source, true)
            this.connectEvents()
          }
        })
        // While the probe is pending, this can only arm the undelivered
        // notice; retryDueAt remains empty until the probe settles.
        this.scheduleRecovery()
      },
      Math.max(0, due - now),
    )
  }

  async retryConnection(): Promise<void> {
    if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.recoveryStartedAt ??= Date.now()
    if (this.eventSource == null || this.eventSource.readyState === 2) {
      this.disposeConnection(this.eventSource ?? undefined, true)
      this.connectEvents()
    }
    const owner = this.eventSource
    const ownerEpoch = this.reconciliationEpoch
    let pending = this.reconciliationPromise
    if (pending == null) {
      this.retryDueAt = null
      this.recoveryAttempt += 1
      pending = this.startReconciliation(!this.sourceOpen)
    }
    // Both manual-start and manual-join leave the notice armed during await.
    this.scheduleRecovery()
    const outcome = await pending
    if (this.eventSource !== owner || this.reconciliationEpoch !== ownerEpoch) return
    if (outcome.result !== 'succeeded' || !this.sourceOpen) this.scheduleRecovery()
  }

  retryNow(): Promise<void> {
    return this.retryConnection()
  }

  async refreshCurrentFolder(): Promise<void> {
    if (this.initialRefreshPromise != null) {
      await this.initialRefreshPromise
      return
    }
    this.initialRefreshStarted = true
    void this.refreshFolders()
    const readEpoch = this.repositoryEpoch
    const lifecycleEpoch = this.reconciliationEpoch
    const operation = this.startReconciliation(false)
    this.initialRefreshPromise = operation
    try {
      const result = await operation
      if (this.reconciliationEpoch === lifecycleEpoch && readEpoch === this.repositoryEpoch)
        this.initialRefreshResult = result
    } finally {
      if (this.initialRefreshPromise === operation) this.initialRefreshPromise = null
    }
  }

  private disposeConnection(owner?: EventSource, preserveRecovery = false): void {
    if (this.eventSource == null || (owner != null && this.eventSource !== owner)) return
    this.disposed = true
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.recoveryTimer != null) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.invalidateReadWork()
    this.reconciliationEpoch += 1
    this.pendingReconciliation = null
    this.reconciliationPromise = null
    this.initialRefreshPromise = null
    this.initialRefreshResult = null
    if (!preserveRecovery) {
      this.unresolvedReconciliationFailure = null
      this.recoveryStartedAt = null
      this.recoveryNoticeAt = null
      this.recoveryNoticeDelivered = false
      this.recoveryTransportLost = false
      this.recoveryAttempt = 0
      this.retryDueAt = null
    }
    this.eventSource.close()
    this.sourceOpen = false
    this.sourceHasOpened = false
    this.eventSource = null
    this.setConnectionState('connecting', null)
  }

  connectEvents(): () => void {
    if (this.eventSource != null) return () => {}
    this.disposed = false
    const source = new EventSource(this.eventsURL)
    this.eventSource = source
    let refreshFiles = false
    let refreshGraph = false
    const scheduleSnapshot = (includeFiles = false, includeGraph = false) => {
      if (this.eventSource !== source) return
      // Membership safety takes effect at receipt, not at coalesced dispatch:
      // an already-pending Snapshot can settle before this timer fires.
      if (includeFiles && this.refreshPromise != null) this.pendingFileMembershipRefresh = 'changed'
      refreshFiles ||= includeFiles
      refreshGraph ||= includeGraph
      if (this.refreshTimer != null) return
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null
        const shouldRefreshFiles = refreshFiles
        const shouldRefreshGraph = refreshGraph
        refreshFiles = false
        refreshGraph = false
        void this.startReconciliation(
          !this.sourceOpen,
          shouldRefreshFiles ? 'changed' : 'unchanged',
          shouldRefreshFiles,
          shouldRefreshGraph,
        )
      }, 150)
    }
    source.addEventListener('open', () => {
      if (this.eventSource !== source) return
      this.sourceOpen = true
      // An open transport retires the old unavailable deadline. Catch-up
      // reconciliation may still retry, but it must not become unreachable
      // solely because the historical outage lasted ten seconds.
      this.recoveryTransportLost = false
      this.recoveryNoticeAt = null
      this.recoveryNoticeDelivered = false
      if (this.recoveryTimer != null) {
        clearTimeout(this.recoveryTimer)
        this.recoveryTimer = null
      }
      markStartup('sse-ready')
      if (this.initialRefreshStarted && this.initialRefreshPromise != null) {
        // The owned operation will publish its captured outcome. Do not attach
        // a second finalizer that can erase its failure or certify a probe.
        this.setConnectionState('reconciling', null)
      } else if (!this.sourceHasOpened && this.initialRefreshResult?.result === 'succeeded') {
        this.finishReconciliation(this.initialRefreshResult)
      } else if (this.initialRefreshStarted && this.initialRefreshResult != null) {
        void this.startReconciliation(false)
      } else if (this.sourceHasOpened) {
        this.setConnectionState('reconciling', null)
        scheduleSnapshot(true, true)
      } else if (this.initialRefreshStarted) {
        this.setConnectionState('reconciling', null)
        void this.startReconciliation(false)
      } else {
        this.setConnectionState('reconciling', null)
      }
      this.sourceHasOpened = true
    })
    source.addEventListener('error', () => {
      if (this.eventSource !== source) return
      this.sourceOpen = false
      this.invalidateReadWork()
      if (!this.recoveryTransportLost) {
        this.recoveryStartedAt = Date.now()
        this.recoveryNoticeAt = this.recoveryStartedAt + RECOVERY_OUTAGE_NOTICE
        this.recoveryNoticeDelivered = false
        this.recoveryTransportLost = true
      }
      this.setConnectionState('reconnecting', 'Backend connection lost')
      this.scheduleRecovery()
    })
    source.addEventListener('snapshot-invalidated', () => scheduleSnapshot())
    source.addEventListener('files-invalidated', () => scheduleSnapshot(true))
    source.addEventListener('graph-invalidated', () => {
      scheduleSnapshot()
      if (this.sourceOpen && this.snapshot?.repository) this.graphInvalidation = this.readGraph()
    })
    if (this.retryDueAt != null || this.recoveryTransportLost) this.scheduleRecovery()
    let cleanedUp = false
    return () => {
      if (cleanedUp) return
      cleanedUp = true
      this.disposeConnection()
    }
  }

  async refreshGraph(countRecovery = 0): Promise<ReadResult> {
    return (await this.readGraph(countRecovery)).result
  }

  private async readGraph(countRecovery = 0): Promise<ReconciliationOutcome> {
    const request = ++this.graphRequest
    const countRequest = ++this.graphCountRequest
    const epoch = this.repositoryEpoch
    this.graphController?.abort()
    this.graphCountController?.abort()
    this.graphCountController = null
    this.graphCountLoading = false
    const controller = new AbortController()
    this.graphController = controller
    this.graphLoading = true
    this.graphError = null
    this.emit()
    try {
      let page
      for (let attempt = 0; ; attempt += 1) {
        try {
          page = await this.api.graph(0, undefined, controller.signal)
          break
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.status !== 409 ||
            attempt >= 2 ||
            controller.signal.aborted ||
            request !== this.graphRequest ||
            epoch !== this.repositoryEpoch
          ) {
            throw error
          }
        }
      }
      if (request !== this.graphRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
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
      if (
        this.commitDiff != null &&
        !this.commitDiff.fromSearch &&
        !present.has(this.commitDiff.oid)
      ) {
        this.commitDiff = null
      }
      if (page.tip !== '' && this.graphTotal == null) {
        void this.loadGraphCount(page.tip, page.generation, countRequest, epoch, countRecovery)
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
      return controller.signal.aborted ||
        epoch !== this.repositoryEpoch ||
        request !== this.graphRequest
        ? reconciliationOutcome('obsolete')
        : reconciliationOutcome('failed', errorMessage(error), 'graph')
    } finally {
      if (this.graphController === controller) this.graphController = null
      if (request === this.graphRequest && epoch === this.repositoryEpoch) {
        this.graphLoading = false
        this.emit()
      }
    }
    return reconciliationOutcome('succeeded')
  }

  private async loadGraphCount(
    tip: string,
    generation: number,
    request: number,
    epoch: number,
    recovery: number,
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
    let refresh = false
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
    } catch (error) {
      refresh =
        error instanceof ApiError &&
        error.status === 409 &&
        recovery < 2 &&
        !controller.signal.aborted &&
        request === this.graphCountRequest &&
        epoch === this.repositoryEpoch &&
        tip === this.graphTip &&
        generation === this.graphGeneration
      // Other count failures leave loaded history usable and truthful.
    } finally {
      if (this.graphCountController === controller) {
        this.graphCountController = null
        if (request === this.graphCountRequest && epoch === this.repositoryEpoch) {
          this.graphCountLoading = false
          this.emit()
        }
      }
    }
    if (
      refresh &&
      request === this.graphCountRequest &&
      epoch === this.repositoryEpoch &&
      !controller.signal.aborted
    )
      await this.refreshGraph(recovery + 1)
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
    if (
      refresh &&
      request === this.graphRequest &&
      epoch === this.repositoryEpoch &&
      !controller.signal.aborted
    )
      await this.refreshGraph()
  }

  async loadCommitDetails(oid: string): Promise<void> {
    if (this.commitFiles[oid] != null || this.filesLoading[oid]) return
    const epoch = this.gitDetailEpoch
    this.filesLoading = { ...this.filesLoading, [oid]: true }
    const { [oid]: _previous, ...remainingErrors } = this.filesError
    this.filesError = remainingErrors
    this.emit()
    try {
      const { files, stats } = await this.api.commitFiles(oid)
      if (epoch !== this.gitDetailEpoch) return
      this.commitFiles = { ...this.commitFiles, [oid]: files }
      if (stats != null) this.commitStats = { ...this.commitStats, [oid]: stats }
    } catch (error) {
      if (epoch === this.gitDetailEpoch) {
        this.filesError = { ...this.filesError, [oid]: errorMessage(error) }
      }
    } finally {
      if (epoch === this.gitDetailEpoch) {
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
    if (this.isUntitledPath(path)) return this.untitledDocument(path) != null
    if (path.endsWith('/')) return false
    if (this.repositoryPaths.includes(path)) return true
    const snapshot = this.snapshot
    const changes =
      snapshot == null
        ? []
        : [...snapshot.staged, ...snapshot.unstaged].filter((change) => change.path === path)
    if (changes.some((change) => change.scope === 'unstaged' && change.kind === 'deleted'))
      return false
    if (changes.some((change) => change.kind !== 'deleted')) return true
    if (changes.some((change) => change.kind === 'deleted')) return false
    if (this.commitDiff?.path === path && this.commitDiff.kind !== 'deleted') return true
    return this.repositoryPaths.includes(path)
  }

  selectRepositoryFile(path: string, reveal = false): void {
    if (
      (this.connectionState === 'reconnecting' ||
        this.connectionState === 'unreachable' ||
        this.connectionState === 'session-error') &&
      !this.repositoryOpenPaths.includes(path) &&
      !this.isUntitledPath(path)
    )
      return
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

  closeRepositoryFiles(paths: readonly string[], closeComparison = false): void {
    const closing = new Set(paths)
    if (
      !this.repositoryOpenPaths.some((path) => closing.has(path)) &&
      !(closeComparison && this.repositoryFileComparison != null)
    )
      return
    if (closeComparison) {
      this.repositoryFileComparison = null
      this.repositoryFileComparisonActive = false
    }
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
    for (const path of closing) {
      if (this.isUntitledPath(path)) this.documents.delete(path.slice('untitled:'.length))
    }
    this.emit()
  }

  async openCommit(oid: string, subject: string, reveal = false): Promise<void> {
    const epoch = this.repositoryEpoch
    const { files, stats } = await this.api.commitFiles(oid)
    if (epoch !== this.repositoryEpoch) return
    this.compare = null
    this.commitFiles = { ...this.commitFiles, [oid]: files }
    if (stats != null) this.commitStats = { ...this.commitStats, [oid]: stats }
    if (reveal) this.expanded = { ...this.expanded, [oid]: true }
    this.selectCommitFile(oid, subject, files[0] ?? { path: '', kind: 'modified' }, true)
    this.graphReveal = reveal ? { oid } : null
    this.emit()
  }

  selectCommitFile(oid: string, subject: string, file: CommitFile, fromSearch = false): void {
    this.selection = null
    this.repositoryFilePath = null
    this.compareDiff = null
    this.repositoryFileComparisonActive = false
    this.commitDiff = { oid, subject, ...file, ...(fromSearch ? { fromSearch: true } : {}) }
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

  async refreshBranches(): Promise<ReadResult> {
    return (await this.readBranches()).result
  }

  private async readBranches(): Promise<ReconciliationOutcome> {
    const request = ++this.branchesRequest
    const epoch = this.repositoryEpoch
    this.branchesLoading = true
    this.branchesError = null
    this.emit()
    try {
      // Capture each failure when it completes, but drain both reads before
      // releasing the pair. A rejected branch must not detach pending remotes.
      const [branches, remotes] = await Promise.all([
        this.api.branches().then(
          (value) => ({ value, failure: null }),
          (error) => ({
            value: [],
            failure: reconciliationOutcome('failed', errorMessage(error), 'branches'),
          }),
        ),
        this.api.remotes().then(
          (value) => ({ value, failure: null }),
          (error) => ({
            value: [],
            failure: reconciliationOutcome('failed', errorMessage(error), 'remotes'),
          }),
        ),
      ])
      if (request !== this.branchesRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
      const failure = branches.failure ?? remotes.failure
      if (failure != null) {
        this.branchesError = failure.failure
        return failure
      }
      this.branches = branches.value
      this.remotes = remotes.value
    } catch (error) {
      if (request !== this.branchesRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
      this.branchesError = errorMessage(error)
      return reconciliationOutcome('failed', errorMessage(error), 'branches')
    } finally {
      if (request === this.branchesRequest && epoch === this.repositoryEpoch) {
        this.branchesLoading = false
        this.emit()
      }
    }
    return reconciliationOutcome('succeeded')
  }

  async refreshStashes(): Promise<ReadResult> {
    return (await this.readStashes()).result
  }

  private async readStashes(): Promise<ReconciliationOutcome> {
    const request = ++this.stashesRequest
    const epoch = this.repositoryEpoch
    this.stashesLoading = true
    this.stashesError = null
    this.emit()
    try {
      const stashes = await this.api.stashes()
      if (request !== this.stashesRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
      this.stashes = stashes
    } catch (error) {
      if (request !== this.stashesRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
      this.stashesError = errorMessage(error)
      return reconciliationOutcome('failed', errorMessage(error), 'stashes')
    } finally {
      if (request === this.stashesRequest && epoch === this.repositoryEpoch) {
        this.stashesLoading = false
        this.emit()
      }
    }
    return reconciliationOutcome('succeeded')
  }

  async refreshTags(): Promise<ReadResult> {
    return (await this.readTags()).result
  }

  private async readTags(): Promise<ReconciliationOutcome> {
    const request = ++this.tagsRequest
    const epoch = this.repositoryEpoch
    this.tagsLoading = true
    this.tagsError = null
    this.emit()
    try {
      const tags = await this.api.tags()
      if (request !== this.tagsRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
      this.tags = tags
    } catch (error) {
      if (request !== this.tagsRequest || epoch !== this.repositoryEpoch)
        return reconciliationOutcome('obsolete')
      this.tagsError = errorMessage(error)
      return reconciliationOutcome('failed', errorMessage(error), 'tags')
    } finally {
      if (request === this.tagsRequest && epoch === this.repositoryEpoch) {
        this.tagsLoading = false
        this.emit()
      }
    }
    return reconciliationOutcome('succeeded')
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
    const reason = this.getActionDisabledReason()
    if (reason != null) this.rejectAction(reason)
    this.busy = true
    this.activeOp = request.op
    this.emit()
    try {
      await this.api.mutate(request)
      this.mutationError = null
    } catch (error) {
      this.mutationError = errorMessage(error)
      this.recordUncertainMutation(this.activeOpLabel ?? request.op, error)
      throw error
    } finally {
      const refreshes = [this.refreshSnapshot(), this.refreshRepositoryFiles()]
      if (this.commitDiff != null) refreshes.push(this.refreshGraph())
      await Promise.allSettled(refreshes)
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
    await this.runWorktreeOperation('rename-entry', async () => {
      await this.api.renameWorktreeEntry(source, destination)
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
      // A lazy Explorer may not have loaded the destination directory yet. The
      // successful mutation is authoritative, so keep remapped tabs and selection
      // instead of treating absence from the mounted rows as deletion.
      this.repositoryOpenPaths = openPaths
      this.repositoryFilePath = selectedPath
      this.repositorySelectedPaths = selectedPaths
      this.repositoryFileComparison = comparison
      this.worktreeRename = {
        source,
        destination,
        version: (this.worktreeRename?.version ?? 0) + 1,
      }
      this.emit()
    })
  }

  dismissMutationError(error: string): void {
    if (this.mutationError !== error) return
    this.mutationError = null
    this.emit()
  }

  private rejectAction(reason: string): never {
    this.mutationError = reason
    this.emit()
    throw new ActionGuardError(reason)
  }

  private async runWorktreeOperation<T>(label: string, run: () => Promise<T>): Promise<T> {
    const reason = this.getActionDisabledReason()
    if (reason != null) this.rejectAction(reason)
    this.busy = true
    this.activeOp = label
    this.emit()
    try {
      const result = await run()
      this.mutationError = null
      return result
    } catch (error) {
      this.mutationError = errorMessage(error)
      this.recordUncertainMutation(this.activeOpLabel ?? label, error)
      throw error
    } finally {
      await Promise.allSettled([this.refreshSnapshot(), this.refreshRepositoryFiles()])
      this.busy = false
      this.activeOp = null
      this.emit()
    }
  }

  async operation(request: MutateRequest): Promise<void> {
    const reason = this.getActionDisabledReason()
    if (reason != null) this.rejectAction(reason)
    this.busy = true
    this.activeOp = request.op
    this.emit()
    try {
      await this.api.mutate(request)
      this.mutationError = null
    } catch (error) {
      this.mutationError = errorMessage(error)
      this.recordUncertainMutation(this.activeOpLabel ?? request.op, error)
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
    const reason = this.getActionDisabledReason('open-folder')
    if (reason != null) return Promise.reject(new ActionGuardError(reason))
    return signal == null ? this.api.openFolder(path) : this.api.openFolder(path, signal)
  }

  async removeRecentFolder(path: string): Promise<void> {
    const reason = this.getActionDisabledReason()
    if (reason != null) throw new ActionGuardError(reason)
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

  canRevealPath(path: string): boolean {
    if (this.isUntitledPath(path)) return false
    if (!path.endsWith('/')) return this.canOpenRepositoryFile(path)
    if (this.repositoryPaths.some((candidate) => candidate.startsWith(path))) return true
    return [...(this.snapshot?.staged ?? []), ...(this.snapshot?.unstaged ?? [])].some(
      (change) => change.path.startsWith(path) && this.canOpenRepositoryFile(change.path),
    )
  }

  revealPath(path: string): Promise<void> {
    const reason = this.getActionDisabledReason()
    if (reason != null) return Promise.reject(new ActionGuardError(reason))
    if (this.isUntitledPath(path))
      return Promise.reject(new Error('Save the file before revealing it'))
    return this.api.revealPath(path)
  }

  revealFolder(): Promise<void> {
    const reason = this.getActionDisabledReason()
    if (reason != null) return Promise.reject(new ActionGuardError(reason))
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
    const reason = this.getActionDisabledReason()
    if (reason != null) this.rejectAction(reason)
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
      this.recordUncertainMutation('Commit', error)
      throw error
    } finally {
      await Promise.allSettled([
        this.refreshSnapshot(),
        this.refreshRepositoryFiles(),
        this.refreshGraph(),
      ])
      this.busy = false
      this.activeOp = null
      this.emit()
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

export function RepositoryProvider({
  children,
  baseURL,
}: {
  children: ReactNode
  baseURL?: string
}) {
  const storeRef = useRef<GitnaRepository | null>(null)
  storeRef.current ??= new GitnaRepository(
    createApi(baseURL),
    baseURL == null ? undefined : new URL('api/v1/events', baseURL).href,
  )
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
