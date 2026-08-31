import { describe, expect, it, vi } from 'vitest'

import { GitnaRepository } from '../src/diffshub/gitna/repository'
import { ApiError, type ApiClient } from '../src/lib/api'
import type { Branch, DirectoryEntries, GraphPage, RepoSnapshot } from '../src/lib/types'

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

function graphPage(oid: string, generation = 1): GraphPage {
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
    tip: oid,
    generation,
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

  it('retries a full graph refresh when the generation changes while loading', async () => {
    const api = {
      graph: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, 'graph changed while loading'))
        .mockResolvedValueOnce(graphPage('current')),
      graphCount: vi.fn().mockResolvedValue({ tip: 'current', generation: 1, total: 1 }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    await repository.refreshGraph()

    expect(api.graph).toHaveBeenCalledTimes(2)
    expect(repository.graphCommits.map((commit) => commit.oid)).toEqual(['current'])
    expect(repository.graphError).toBeNull()
    expect(repository.graphLoading).toBe(false)
  })

  it('refreshes graph state once when an exact count observes a new generation', async () => {
    const api = {
      graph: vi
        .fn()
        .mockResolvedValueOnce(graphPage('current', 1))
        .mockResolvedValueOnce(graphPage('current', 2)),
      graphCount: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, 'graph changed while counting'))
        .mockResolvedValueOnce({ tip: 'current', generation: 2, total: 1 }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    await repository.refreshGraph()
    await vi.waitFor(() => expect(repository.graphTotal).toBe(1))

    expect(api.graph).toHaveBeenCalledTimes(2)
    expect(api.graphCount).toHaveBeenCalledTimes(2)
    expect(repository.graphGeneration).toBe(2)
    expect(repository.graphCountLoading).toBe(false)
  })

  it('does not loop when an exact count remains invalidated', async () => {
    const api = {
      graph: vi
        .fn()
        .mockResolvedValueOnce(graphPage('current', 1))
        .mockResolvedValueOnce(graphPage('current', 2))
        .mockResolvedValueOnce(graphPage('current', 3)),
      graphCount: vi.fn().mockRejectedValue(new ApiError(409, 'graph changed while counting')),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    await repository.refreshGraph()
    await vi.waitFor(() => expect(api.graphCount).toHaveBeenCalledTimes(3))

    expect(api.graph).toHaveBeenCalledTimes(3)
    expect(api.graphCount).toHaveBeenCalledTimes(3)
    expect(repository.graphTotal).toBeNull()
    expect(repository.graphCountLoading).toBe(false)
  })

  it('publishes the exact Repository file count independently from loaded tree rows', async () => {
    const api = {
      repositoryFileCount: vi.fn().mockResolvedValue({ generation: 2, total: 35_234 }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)
    repository.snapshot = snapshot('/repo', 2)
    repository.generation = 2
    repository.repositoryPaths = ['README.md', 'src/']

    await repository.refreshRepositoryFileCount()

    expect(api.repositoryFileCount).toHaveBeenCalledWith(2, expect.any(AbortSignal))
    expect(repository.repositoryFileTotal).toBe(35_234)
    expect(repository.repositoryFileTotalGeneration).toBe(2)
    expect(repository.repositoryPaths).toEqual(['README.md', 'src/'])
    expect(repository.repositoryFileCountLoading).toBe(false)
  })

  it('refreshes Snapshot before retrying an invalidated Repository file count', async () => {
    const refreshedSnapshot = deferred<RepoSnapshot>()
    const api = {
      snapshot: vi.fn().mockReturnValue(refreshedSnapshot.promise),
      repositoryFileCount: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, 'files changed while counting'))
        .mockResolvedValueOnce({ generation: 2, total: 12 }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)
    repository.snapshot = snapshot('/repo', 1)
    repository.generation = 1

    const refresh = repository.refreshRepositoryFileCount()
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(1))
    expect(api.repositoryFileCount).toHaveBeenCalledTimes(1)

    refreshedSnapshot.resolve(snapshot('/repo', 2))
    await refresh

    expect(api.repositoryFileCount).toHaveBeenNthCalledWith(2, 2, expect.any(AbortSignal))
    expect(repository.repositoryFileTotal).toBe(12)
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

  it('serializes an ordinary-folder refresh behind an in-flight listing', async () => {
    const first = deferred<DirectoryEntries>()
    const second = deferred<DirectoryEntries>()
    const api = {
      directoryEntries: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const initial = repository.loadOrdinaryDirectory('')
    const refresh = repository.loadOrdinaryDirectory('', true)
    expect(api.directoryEntries).toHaveBeenCalledTimes(1)

    first.resolve({
      directory: '',
      entries: [{ kind: 'file', name: 'stale.txt', path: 'stale.txt' }],
      generation: 1,
      truncated: false,
    })
    await vi.waitFor(() => expect(api.directoryEntries).toHaveBeenCalledTimes(2))
    second.resolve({
      directory: '',
      entries: [{ kind: 'file', name: 'current.txt', path: 'current.txt' }],
      generation: 2,
      truncated: false,
    })
    await Promise.all([initial, refresh])

    expect(repository.repositoryPaths).toEqual(['current.txt'])
  })

  it('starts Git data without waiting for the lazy Explorer root', async () => {
    const currentSnapshot = deferred<RepoSnapshot>()
    const files = deferred<DirectoryEntries>()
    const api = {
      snapshot: vi.fn().mockReturnValue(currentSnapshot.promise),
      folders: vi.fn().mockResolvedValue({ current: {}, recent: [] }),
      directoryEntries: vi.fn().mockReturnValue(files.promise),
      graph: vi.fn().mockResolvedValue({ commits: [], hasMore: false }),
      branches: vi.fn().mockResolvedValue([]),
      stashes: vi.fn().mockResolvedValue([]),
      tags: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const refresh = repository.refreshCurrentFolder()
    currentSnapshot.resolve(snapshot('/repo', 1))
    await vi.waitFor(() => expect(api.graph).toHaveBeenCalledTimes(1))
    expect(api.directoryEntries).toHaveBeenCalledTimes(1)

    files.resolve({
      directory: '',
      generation: 1,
      entries: [{ kind: 'file', name: 'ready.txt', path: 'ready.txt' }],
      truncated: false,
    })
    await refresh
    expect(repository.repositoryPaths).toEqual(['ready.txt'])
  })

  it('reloads Explorer when Snapshot wins the initial generation race', async () => {
    const currentSnapshot = deferred<RepoSnapshot>()
    const api = {
      snapshot: vi.fn().mockReturnValue(currentSnapshot.promise),
      folders: vi.fn().mockResolvedValue({ current: {}, recent: [] }),
      directoryEntries: vi
        .fn()
        .mockResolvedValueOnce({
          directory: '',
          generation: 1,
          entries: [{ kind: 'file', name: 'stale.txt', path: 'stale.txt' }],
          truncated: false,
        })
        .mockResolvedValueOnce({
          directory: '',
          generation: 2,
          entries: [{ kind: 'file', name: 'current.txt', path: 'current.txt' }],
          truncated: false,
        }),
      graph: vi.fn().mockResolvedValue({ commits: [], hasMore: false }),
      branches: vi.fn().mockResolvedValue([]),
      stashes: vi.fn().mockResolvedValue([]),
      tags: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const refresh = repository.refreshCurrentFolder()
    expect(api.directoryEntries).not.toHaveBeenCalled()
    currentSnapshot.resolve(snapshot('/repo', 2))
    await vi.waitFor(() => expect(api.directoryEntries).toHaveBeenCalled())
    await refresh

    expect(api.directoryEntries).toHaveBeenCalledTimes(2)
    expect(repository.generation).toBe(2)
    expect(repository.repositoryPaths).toEqual(['current.txt'])
  })

  it('reloads Snapshot when Explorer wins the initial generation race', async () => {
    const currentFiles = deferred<DirectoryEntries>()
    const api = {
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot('/repo', 1))
        .mockResolvedValueOnce(snapshot('/repo', 2)),
      folders: vi.fn().mockResolvedValue({ current: {}, recent: [] }),
      directoryEntries: vi.fn().mockReturnValue(currentFiles.promise),
      graph: vi.fn().mockResolvedValue({ commits: [], hasMore: false }),
      branches: vi.fn().mockResolvedValue([]),
      stashes: vi.fn().mockResolvedValue([]),
      tags: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const refresh = repository.refreshCurrentFolder()
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(1))
    currentFiles.resolve({
      directory: '',
      generation: 2,
      entries: [{ kind: 'file', name: 'current.txt', path: 'current.txt' }],
      truncated: false,
    })
    await refresh

    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(repository.generation).toBe(2)
    expect(repository.repositoryPaths).toEqual(['current.txt'])
  })

  it('forwards folder-switch cancellation without mutating busy state', async () => {
    const controller = new AbortController()
    const api = {
      openFolder: vi.fn().mockResolvedValue({ root: '/new', href: '../new/' }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    await repository.openFolder('/new', controller.signal)

    expect(api.openFolder).toHaveBeenCalledWith('/new', controller.signal)
    expect(repository.busy).toBe(false)
    expect(repository.activeOp).toBeNull()
  })

  it('keeps the current snapshot while resolving another folder route', async () => {
    const currentSnapshot = deferred<RepoSnapshot>()
    const api = {
      snapshot: vi.fn().mockReturnValueOnce(currentSnapshot.promise),
      openFolder: vi.fn().mockResolvedValue({ root: '/new', href: '../new/' }),
    } as unknown as ApiClient
    const repository = new GitnaRepository(api)

    const initialRefresh = repository.refreshSnapshot()
    const switching = repository.openFolder('/new')
    currentSnapshot.resolve(snapshot('/old', 99))
    const [, result] = await Promise.all([initialRefresh, switching])

    expect(result).toEqual({ root: '/new', href: '../new/' })
    expect(repository.snapshot?.root).toBe('/old')
    expect(repository.generation).toBe(99)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
  })
})
