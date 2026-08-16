import type { ChangeScope, FileDiff, RepoSnapshot } from './types'

export interface DiffRequest {
  scope: ChangeScope
  path: string
  oldPath?: string
}

export interface ApiClient {
  snapshot(): Promise<RepoSnapshot>
  diff(request: DiffRequest): Promise<FileDiff>
}

async function expectOK(res: Response): Promise<Response> {
  if (!res.ok) {
    throw new Error(`request failed: ${res.status}`)
  }
  return res
}

export function diffQuery(request: DiffRequest): string {
  const params = new URLSearchParams({ scope: request.scope, path: request.path })
  if (request.oldPath) params.set('oldPath', request.oldPath)
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
  }
}
