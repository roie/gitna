import type { RepoSnapshot } from './types'

export interface ApiClient {
  snapshot(): Promise<RepoSnapshot>
}

async function expectOK(res: Response): Promise<Response> {
  if (!res.ok) {
    throw new Error(`request failed: ${res.status}`)
  }
  return res
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
  }
}
