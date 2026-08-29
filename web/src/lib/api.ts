import type {
  Branch,
  CommitFiles,
  ConflictEntry,
  DirectoryEntries,
  DiffScope,
  FileDiff,
  FileSearchResults,
  GraphCount,
  GraphPage,
  OpenFolderResult,
  RepositoryFiles,
  RepoSnapshot,
  ReviewResponse,
  StashEntry,
  Tag,
  FolderCatalog,
  WorktreeFile,
} from './types'

export interface DiffRequest {
  scope: DiffScope
  path: string
  oldPath?: string
  commit?: string
  /** Refs for the compare scope; both are required when scope is 'compare'. */
  from?: string
  to?: string
}

export interface ReviewRequest {
  scope: DiffScope
  commit?: string
  from?: string
  to?: string
  cursor?: string
  signal?: AbortSignal
}

/** Mutation operation names accepted by the operations endpoint. */
export type MutationOp =
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'delete'
  | 'patch'
  | 'create-branch'
  | 'switch-branch'
  | 'delete-branch'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'push-upstream'
  | 'stash-push'
  | 'stash-apply'
  | 'stash-pop'
  | 'stash-drop'
  | 'create-tag'
  | 'delete-tag'
  | 'push-tag'
  | 'cherry-pick'
  | 'cherry-pick-abort'
  | 'cherry-pick-continue'
  | 'revert'
  | 'revert-abort'
  | 'revert-continue'
  | 'reset'
  | 'merge'
  | 'merge-abort'
  | 'merge-continue'
  | 'rebase'
  | 'rebase-abort'
  | 'rebase-continue'
  | 'resolve-ours'
  | 'resolve-theirs'
  | 'resolve-both'

export interface MutateRequest {
  op: MutationOp
  paths?: string[]
  patch?: string
  patchId?: string
  scope?: DiffScope
  path?: string
  reverse?: boolean
  /** Branch name for branch operations, the branch for push-upstream, or the
   * tag name for tag operations. */
  name?: string
  /** Ref or oid a new branch or tag is created at; empty means HEAD. */
  start?: string
  /** Remote name for push-upstream and push-tag. */
  remote?: string
  /** Force branch delete after explicit confirmation. */
  force?: boolean
  /** Stash entry ref for stash apply/pop/drop, or the target of a history
   * mutation (cherry-pick, revert, reset). */
  ref?: string
  /** Reset mode: soft, mixed, or hard. */
  mode?: string
  /** Carry untracked files with a stash push. */
  includeUntracked?: boolean
  /** Message for a stash push or an annotated tag. */
  message?: string
}

export interface CommitRequest {
  message: string
  amend?: boolean
}

/** Outcome of a commit operation. Hooks run normally; a rejected commit
 * returns OK=false with git's exit code and output so the UI can show the
 * hook's reason while preserving the user's text. */
export interface OperationResult {
  ok: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
}

export interface ApiClient {
  snapshot(): Promise<RepoSnapshot>
  folders(): Promise<FolderCatalog>
  repositoryFiles(cursor?: string): Promise<RepositoryFiles>
  directoryEntries(path: string, cursor?: string, signal?: AbortSignal): Promise<DirectoryEntries>
  searchFiles(
    query: string,
    options?: {
      recentPaths?: readonly string[]
      refresh?: boolean
      signal?: AbortSignal
    },
  ): Promise<FileSearchResults>
  readWorktreeFile(path: string): Promise<WorktreeFile>
  writeWorktreeFile(path: string, content: string, expectedHash: string): Promise<WorktreeFile>
  createWorktreeEntry(path: string, directory: boolean): Promise<void>
  renameWorktreeEntry(source: string, destination: string): Promise<void>
  diff(request: DiffRequest): Promise<FileDiff>
  review(request: ReviewRequest): Promise<ReviewResponse>
  mutate(request: MutateRequest): Promise<void>
  commit(request: CommitRequest): Promise<OperationResult>
  graph(skip?: number, tip?: string, signal?: AbortSignal): Promise<GraphPage>
  graphCount(tip: string, signal?: AbortSignal): Promise<GraphCount>
  commitFiles(oid: string): Promise<CommitFiles>
  branches(): Promise<Branch[]>
  stashes(): Promise<StashEntry[]>
  tags(): Promise<Tag[]>
  compare(from: string, to: string): Promise<CommitFiles>
  conflicts(): Promise<ConflictEntry[]>
  openFolder(path: string, signal?: AbortSignal): Promise<OpenFolderResult>
  removeRecentFolder(path: string): Promise<void>
  revealFolder(): Promise<void>
}

/** Error carrying the HTTP status and server message so callers can react to
 * specific failures. code carries a structured classification when the server
 * provides one (no-upstream, branch-not-merged), and branch names the current
 * branch when a push has no upstream. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly branch?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Timeout for client-side fetch abort (server enforces its own limits, but
 * the client needs a cap so the UI can show a meaningful error). */
const FETCH_TIMEOUT = 30_000
const MUTATE_TIMEOUT = 120_000

async function expectOK(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string
      code?: string
      branch?: string
    } | null
    throw new ApiError(
      res.status,
      body?.error ?? `request failed: ${res.status}`,
      body?.code,
      body?.branch,
    )
  }
  return res
}

export function diffQuery(request: DiffRequest): string {
  const params = new URLSearchParams({ scope: request.scope, path: request.path })
  if (request.oldPath) params.set('oldPath', request.oldPath)
  if (request.commit) params.set('commit', request.commit)
  if (request.from) params.set('from', request.from)
  if (request.to) params.set('to', request.to)
  return params.toString()
}

export function reviewQuery(request: ReviewRequest): string {
  const params = new URLSearchParams({ scope: request.scope })
  if (request.commit) params.set('commit', request.commit)
  if (request.from) params.set('from', request.from)
  if (request.to) params.set('to', request.to)
  if (request.cursor) params.set('cursor', request.cursor)
  return params.toString()
}

/**
 * API client for the local workbench. All requests are same-origin relative to
 * the capability URL, so no absolute base is needed.
 */
export function createApi(): ApiClient {
  return {
    async snapshot(): Promise<RepoSnapshot> {
      const res = await expectOK(
        await fetch('api/v1/snapshot', { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as RepoSnapshot
    },
    async folders(): Promise<FolderCatalog> {
      const res = await expectOK(
        await fetch('api/v1/folders', { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as FolderCatalog
    },
    async repositoryFiles(cursor?: string): Promise<RepositoryFiles> {
      const query = cursor == null ? '' : `?cursor=${encodeURIComponent(cursor)}`
      const res = await expectOK(
        await fetch(`api/v1/files${query}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as RepositoryFiles
    },
    async directoryEntries(
      path: string,
      cursor?: string,
      signal?: AbortSignal,
    ): Promise<DirectoryEntries> {
      const query = new URLSearchParams({ path })
      if (cursor != null) query.set('cursor', cursor)
      const res = await expectOK(
        await fetch(`api/v1/directory?${query.toString()}`, {
          signal:
            signal == null
              ? AbortSignal.timeout(FETCH_TIMEOUT)
              : AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
        }),
      )
      return (await res.json()) as DirectoryEntries
    },
    async searchFiles(
      query: string,
      options: {
        recentPaths?: readonly string[]
        refresh?: boolean
        signal?: AbortSignal
      } = {},
    ): Promise<FileSearchResults> {
      const params = new URLSearchParams({ q: query })
      for (const path of options.recentPaths?.slice(-20) ?? []) params.append('recent', path)
      if (options.refresh === true) params.set('refresh', '1')
      const res = await expectOK(
        await fetch(`api/v1/files/search?${params.toString()}`, {
          signal:
            options.signal == null
              ? AbortSignal.timeout(FETCH_TIMEOUT)
              : AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
        }),
      )
      return (await res.json()) as FileSearchResults
    },
    async readWorktreeFile(path: string): Promise<WorktreeFile> {
      const res = await expectOK(
        await fetch(`api/v1/worktree/file?path=${encodeURIComponent(path)}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        }),
      )
      return (await res.json()) as WorktreeFile
    },
    async writeWorktreeFile(
      path: string,
      content: string,
      expectedHash: string,
    ): Promise<WorktreeFile> {
      const res = await expectOK(
        await fetch('api/v1/worktree/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content, expectedHash }),
          signal: AbortSignal.timeout(MUTATE_TIMEOUT),
        }),
      )
      return (await res.json()) as WorktreeFile
    },
    async createWorktreeEntry(path: string, directory: boolean): Promise<void> {
      await expectOK(
        await fetch('api/v1/worktree/entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, directory }),
          signal: AbortSignal.timeout(MUTATE_TIMEOUT),
        }),
      )
    },
    async renameWorktreeEntry(source: string, destination: string): Promise<void> {
      await expectOK(
        await fetch('api/v1/worktree/entry', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, destination }),
          signal: AbortSignal.timeout(MUTATE_TIMEOUT),
        }),
      )
    },
    async diff(request: DiffRequest): Promise<FileDiff> {
      const res = await expectOK(
        await fetch(`api/v1/diff?${diffQuery(request)}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        }),
      )
      return (await res.json()) as FileDiff
    },
    async review(request: ReviewRequest): Promise<ReviewResponse> {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT)
      const res = await expectOK(
        await fetch(`api/v1/review?${reviewQuery(request)}`, {
          signal: request.signal == null ? timeout : AbortSignal.any([request.signal, timeout]),
        }),
      )
      return (await res.json()) as ReviewResponse
    },
    async mutate(request: MutateRequest): Promise<void> {
      const body = {
        paths: request.paths,
        patch: request.patch,
        patchId: request.patchId,
        scope: request.scope,
        path: request.path,
        reverse: request.reverse,
        name: request.name,
        start: request.start,
        remote: request.remote,
        force: request.force,
        ref: request.ref,
        mode: request.mode,
        includeUntracked: request.includeUntracked,
        message: request.message,
      }
      const res = await fetch(`api/v1/operations?op=${request.op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MUTATE_TIMEOUT),
      })
      await expectOK(res)
    },
    async commit(request: CommitRequest): Promise<OperationResult> {
      const res = await expectOK(
        await fetch('api/v1/operations?op=commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: request.message, amend: request.amend }),
          signal: AbortSignal.timeout(MUTATE_TIMEOUT),
        }),
      )
      return (await res.json()) as OperationResult
    },
    async graph(skip = 0, tip?: string, signal?: AbortSignal): Promise<GraphPage> {
      const query = new URLSearchParams({ skip: String(skip) })
      if (tip != null && tip !== '') query.set('tip', tip)
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT)
      const res = await expectOK(
        await fetch(`api/v1/graph?${query}`, {
          signal: signal == null ? timeout : AbortSignal.any([signal, timeout]),
        }),
      )
      return (await res.json()) as GraphPage
    },
    async graphCount(tip: string, signal?: AbortSignal): Promise<GraphCount> {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT)
      const res = await expectOK(
        await fetch(`api/v1/graph/count?tip=${encodeURIComponent(tip)}`, {
          signal: signal == null ? timeout : AbortSignal.any([signal, timeout]),
        }),
      )
      return (await res.json()) as GraphCount
    },
    async commitFiles(oid: string): Promise<CommitFiles> {
      const res = await expectOK(
        await fetch(`api/v1/commit/${oid}/files`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as CommitFiles
    },
    async branches(): Promise<Branch[]> {
      const res = await expectOK(
        await fetch('api/v1/branches', { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as Branch[]
    },
    async stashes(): Promise<StashEntry[]> {
      const res = await expectOK(
        await fetch('api/v1/stashes', { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as StashEntry[]
    },
    async tags(): Promise<Tag[]> {
      const res = await expectOK(
        await fetch('api/v1/tags', { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as Tag[]
    },
    async compare(from: string, to: string): Promise<CommitFiles> {
      const res = await expectOK(
        await fetch(
          `api/v1/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
        ),
      )
      return (await res.json()) as CommitFiles
    },
    async conflicts(): Promise<ConflictEntry[]> {
      const res = await expectOK(
        await fetch('api/v1/conflicts', { signal: AbortSignal.timeout(FETCH_TIMEOUT) }),
      )
      return (await res.json()) as ConflictEntry[]
    },
    async openFolder(path: string, signal?: AbortSignal): Promise<OpenFolderResult> {
      const timeout = AbortSignal.timeout(MUTATE_TIMEOUT)
      const res = await expectOK(
        await fetch('api/v1/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
          signal: signal == null ? timeout : AbortSignal.any([signal, timeout]),
        }),
      )
      return (await res.json()) as OpenFolderResult
    },
    async removeRecentFolder(path: string): Promise<void> {
      await expectOK(
        await fetch('api/v1/folders/recent', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
          signal: AbortSignal.timeout(MUTATE_TIMEOUT),
        }),
      )
    },
    async revealFolder(): Promise<void> {
      await expectOK(
        await fetch('api/v1/folder/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(MUTATE_TIMEOUT),
        }),
      )
    },
  }
}
