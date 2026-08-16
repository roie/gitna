import type { Branch, CommitFiles, DiffScope, FileDiff, GraphPage, RepoSnapshot } from './types'

export interface DiffRequest {
  scope: DiffScope
  path: string
  oldPath?: string
  commit?: string
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

export interface MutateRequest {
  op: MutationOp
  paths?: string[]
  patch?: string
  reverse?: boolean
  /** Branch name for branch operations and the branch for push-upstream. */
  name?: string
  /** Ref or oid a new branch is created at; empty means HEAD. */
  start?: string
  /** Remote name for push-upstream. */
  remote?: string
  /** Force branch delete after explicit confirmation. */
  force?: boolean
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
  diff(request: DiffRequest): Promise<FileDiff>
  mutate(request: MutateRequest): Promise<void>
  commit(request: CommitRequest): Promise<OperationResult>
  graph(skip?: number): Promise<GraphPage>
  commitFiles(oid: string): Promise<CommitFiles>
  branches(): Promise<Branch[]>
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

async function expectOK(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; code?: string; branch?: string }
      | null
    throw new ApiError(res.status, body?.error ?? `request failed: ${res.status}`, body?.code, body?.branch)
  }
  return res
}

export function diffQuery(request: DiffRequest): string {
  const params = new URLSearchParams({ scope: request.scope, path: request.path })
  if (request.oldPath) params.set('oldPath', request.oldPath)
  if (request.commit) params.set('commit', request.commit)
  return params.toString()
}

/**
 * API client for the local workbench. All requests are same-origin relative to
 * the capability URL, so no absolute base is needed.
 */
export function createApi(): ApiClient {
  return {
    async snapshot(): Promise<RepoSnapshot> {
      const res = await expectOK(await fetch('api/v1/snapshot'))
      return (await res.json()) as RepoSnapshot
    },
    async diff(request: DiffRequest): Promise<FileDiff> {
      const res = await expectOK(await fetch(`api/v1/diff?${diffQuery(request)}`))
      return (await res.json()) as FileDiff
    },
    async mutate(request: MutateRequest): Promise<void> {
      const body = {
        paths: request.paths,
        patch: request.patch,
        reverse: request.reverse,
        name: request.name,
        start: request.start,
        remote: request.remote,
        force: request.force,
      }
      const res = await fetch(`api/v1/operations?op=${request.op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await expectOK(res)
    },
    async commit(request: CommitRequest): Promise<OperationResult> {
      const res = await expectOK(
        await fetch('api/v1/operations?op=commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: request.message, amend: request.amend }),
        }),
      )
      return (await res.json()) as OperationResult
    },
    async graph(skip = 0): Promise<GraphPage> {
      const res = await expectOK(await fetch(`api/v1/graph?skip=${skip}`))
      return (await res.json()) as GraphPage
    },
    async commitFiles(oid: string): Promise<CommitFiles> {
      const res = await expectOK(await fetch(`api/v1/commit/${oid}/files`))
      return (await res.json()) as CommitFiles
    },
    async branches(): Promise<Branch[]> {
      const res = await expectOK(await fetch('api/v1/branches'))
      return (await res.json()) as Branch[]
    },
  }
}
