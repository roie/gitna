import type { CommitFiles, DiffScope, FileDiff, GraphPage, RepoSnapshot } from './types'

export interface DiffRequest {
  scope: DiffScope
  path: string
  oldPath?: string
  commit?: string
}

/** Mutation operation names accepted by the operations endpoint. */
export type MutationOp = 'stage' | 'unstage' | 'discard' | 'delete' | 'patch'

export interface MutateRequest {
  op: MutationOp
  paths?: string[]
  patch?: string
  reverse?: boolean
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
}

/** Error carrying the HTTP status and server message so callers can react to
 * specific failures such as a stale patch (409). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function expectOK(res: Response): Promise<Response> {
  if (!res.ok) {
    const message = await readError(res)
    throw new ApiError(res.status, message)
  }
  return res
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // Fall through to the generic status message when the body is not JSON.
  }
  return `request failed: ${res.status}`
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
      const body = { paths: request.paths, patch: request.patch, reverse: request.reverse }
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
  }
}
