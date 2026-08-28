import { describe, expect, it, vi } from 'vitest'

import { GitnaRepository } from '../src/diffshub/gitna/repository'
import type { ApiClient } from '../src/lib/api'
import type { Branch, GraphPage, RepositoryFiles, RepoSnapshot } from '../src/lib/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(root: string, generation: number): RepoSnapshot {
  return {
    appVersion: 'dev',
    repository: true,
    root,
    ahead: 0,
    behind: 0,
    operation: '',
    staged: [],
    unstaged: [],
    generation,
  }
}

function graphPage(oid: string): GraphPage {
  return {
    commits: [
      {
        oid,
        parents: [],
        subject: oid,
        authorName: 'Test',
        authorTime: '2026-01-01T00:00:00Z',
        refs: [],
      },
    ],
    hasMore: false,
  }
}

describe('GitnaRepository request sequencing', () => {
  it('keeps the newest graph when refreshes resolve out of order', async () => {
    const first = deferred<GraphPage>()
    const second = deferred<GraphPage>()
    const api = {
      graph: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const firstRefresh = repository.refreshGraph()
    const secondRefresh = repository.refreshGraph()
    second.resolve(graphPage('new'))
    await secondRefresh
    first.resolve(graphPage('old'))
    await firstRefresh

    expect(repository.graphCommits.map((commit) => commit.oid)).toEqual(['new'])
    expect(repository.graphLoading).toBe(false)
  })

  it('keeps the newest branches when refreshes resolve out of order', async () => {
    const first = deferred<Branch[]>()
    const second = deferred<Branch[]>()
    const api = {
      branches: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const firstRefresh = repository.refreshBranches()
    const secondRefresh = repository.refreshBranches()
    second.resolve([{ name: 'new', oid: 'new', current: true, remote: false, ahead: 0, behind: 0 }])
    await secondRefresh
    first.resolve([{ name: 'old', oid: 'old', current: true, remote: false, ahead: 0, behind: 0 }])
    await firstRefresh

    expect(repository.branches.map((branch) => branch.name)).toEqual(['new'])
    expect(repository.branchesLoading).toBe(false)
  })

  it('publishes paged Explorer files atomically', async () => {
    const finalPage = deferred<RepositoryFiles>()
    const api = {
      repositoryFiles: vi
        .fn()
        .mockResolvedValueOnce({
          generation: 1,
          paths: ['new/first.txt'],
          truncated: true,
          nextCursor: 'new/first.txt',
        })
        .mockReturnValueOnce(finalPage.promise),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)
    repository.repositoryPaths = ['existing/file.txt']

    const refresh = repository.refreshRepositoryFiles()
    await vi.waitFor(() => expect(api.repositoryFiles).toHaveBeenCalledTimes(2))

    expect(repository.repositoryPaths).toEqual(['existing/file.txt'])
    finalPage.resolve({ generation: 1, paths: ['new/second.txt'], truncated: false })
    await refresh

    expect(repository.repositoryPaths).toEqual(['new/first.txt', 'new/second.txt'])
    expect(repository.repositoryFilesLoading).toBe(false)
  })

  it('discards an old snapshot while switching repositories', async () => {
    const oldSnapshot = deferred<RepoSnapshot>()
    const api = {
      snapshot: vi
        .fn()
        .mockReturnValueOnce(oldSnapshot.promise)
        .mockResolvedValueOnce(snapshot('/new', 1)),
      repositoryFiles: vi.fn().mockResolvedValue({ generation: 1, paths: [], truncated: false }),
      graph: vi.fn().mockResolvedValue({ commits: [], hasMore: false }),
      branches: vi.fn().mockResolvedValue([]),
      openFolder: vi.fn().mockResolvedValue({ root: '/new' }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const initialRefresh = repository.refreshSnapshot()
    const switching = repository.openFolder('/new')
    oldSnapshot.resolve(snapshot('/old', 99))
    await Promise.all([initialRefresh, switching])
    expect(api.graph).toHaveBeenCalled()

    expect(repository.snapshot?.root).toBe('/new')
    expect(repository.generation).toBe(1)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })
})
