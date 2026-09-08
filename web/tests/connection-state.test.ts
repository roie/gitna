import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitnaRepository } from '../src/diffshub/gitna/repository'
import { ApiError, type ApiClient } from '../src/lib/api'
import type { DirectoryEntries, GraphPage, RepoSnapshot } from '../src/lib/types'

function snapshot(generation = 1, repository = true): RepoSnapshot {
  return {
    appVersion: 'dev',
    repository,
    root: '/repo',
    ahead: 0,
    behind: 0,
    operation: '',
    staged: [],
    unstaged: [],
    generation,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

class TestEventSource {
  static current: TestEventSource | null = null
  static instances: TestEventSource[] = []
  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor() {
    TestEventSource.instances.push(this)
    TestEventSource.current = this
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  dispatch(type: string): void {
    if (type === 'open') this.readyState = 1
    if (type === 'error' && this.readyState !== 2) this.readyState = 0
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  close(): void {
    this.readyState = 2
    this.closeCount += 1
  }
}

function apiFor(snapshotResult: () => Promise<RepoSnapshot>): ApiClient {
  return {
    snapshot: vi.fn(snapshotResult),
    folders: vi.fn(async () => ({ current: {}, recent: [] })),
    repositoryFileCount: vi.fn(async (generation: number) => ({ generation, total: 12 })),
    async directoryEntries(directory: string) {
      return { directory, entries: [], generation: 1, truncated: false }
    },
    async graph() {
      return { commits: [], hasMore: false, tip: '', generation: 1 }
    },
    async branches() {
      return []
    },
    async remotes() {
      return []
    },
    async stashes() {
      return []
    },
    async tags() {
      return []
    },
  } as unknown as ApiClient
}

describe('GitnaRepository connection owner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    TestEventSource.instances = []
    TestEventSource.current = null
    vi.stubGlobal('EventSource', TestEventSource)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('joins an open event to the initial read without duplicating it', async () => {
    const current = deferred<RepoSnapshot>()
    const api = apiFor(() => current.promise)
    const repository = new GitnaRepository(api)
    const loading = repository.refreshCurrentFolder()
    const cleanup = repository.connectEvents()
    TestEventSource.current?.dispatch('open')
    current.resolve(snapshot())
    await loading

    expect(api.snapshot).toHaveBeenCalledTimes(1)
    expect(repository.connectionState).toBe('connected')
    cleanup()
  })

  it('does not fan out reads after a failed Snapshot', async () => {
    const graph = vi.fn()
    const api = apiFor(async () => {
      throw new Error('offline')
    })
    api.graph = graph
    const repository = new GitnaRepository(api)

    await repository.refreshCurrentFolder()

    expect(graph).not.toHaveBeenCalled()
    expect(repository.connectionState).toBe('connecting')
    expect(repository.error).toBe('offline')
  })

  it('preserves a native CONNECTING source after transport loss', async () => {
    const api = apiFor(async () => snapshot())
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('error')

    expect(repository.connectionState).toBe('reconnecting')
    expect(source.readyState).toBe(0)
    expect(TestEventSource.current).toBe(source)
    cleanup()
  })

  it('does not reuse initial readiness after transport loss and reopen', async () => {
    const replacement = deferred<RepoSnapshot>()
    const api = apiFor(
      vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(replacement.promise),
    )
    const repository = new GitnaRepository(api)
    const loading = repository.refreshCurrentFolder()
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    expect(repository.connectionReady).toBe(true)

    source.dispatch('error')
    source.dispatch('open')
    await vi.advanceTimersByTimeAsync(150)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(repository.connectionReady).toBe(false)

    replacement.resolve(snapshot(2))
    await vi.advanceTimersByTimeAsync(0)
    cleanup()
  })

  it('does not notify unreachable after transport reopens during catch-up', async () => {
    const catchup = deferred<RepoSnapshot>()
    const api = apiFor(
      vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(catchup.promise),
    )
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await repository.refreshCurrentFolder()
    expect(repository.connectionReady).toBe(true)

    source.dispatch('error')
    source.dispatch('open')
    await vi.advanceTimersByTimeAsync(150)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(repository.connectionState).not.toBe('unreachable')
    catchup.resolve(snapshot(2))
    await vi.advanceTimersByTimeAsync(0)
    cleanup()
  })

  it('does not reuse startup success when transport is lost before the first open', async () => {
    const replacement = deferred<RepoSnapshot>()
    const api = apiFor(
      vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(replacement.promise),
    )
    const repository = new GitnaRepository(api)
    await repository.refreshCurrentFolder()
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('error')
    source.dispatch('open')

    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(repository.connectionReady).toBe(false)
    replacement.resolve(snapshot(2))
    cleanup()
  })

  it('publishes a subscriber notification when readiness succeeds after startup', async () => {
    const api = apiFor(async () => snapshot())
    const repository = new GitnaRepository(api)
    await repository.refreshCurrentFolder()
    const notifications = vi.fn()
    repository.subscribe(notifications)
    const version = repository.getVersion()
    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('open')

    expect(repository.connectionReady).toBe(true)
    expect(repository.getVersion()).toBeGreaterThan(version)
    expect(notifications).toHaveBeenCalled()
    cleanup()
  })

  it('does not let an old cleanup close the replacement source', () => {
    const repository = new GitnaRepository(apiFor(async () => snapshot()))
    const cleanupA = repository.connectEvents()
    const sourceA = TestEventSource.current!
    cleanupA()
    const cleanupB = repository.connectEvents()
    const sourceB = TestEventSource.current!

    cleanupA()

    expect(sourceA.closeCount).toBe(1)
    expect(sourceB.closeCount).toBe(0)
    expect(TestEventSource.current).toBe(sourceB)
    cleanupB()
  })

  it.each([false, true])(
    'does not join a replacement lifecycle to an old Snapshot (%s)',
    async (rejectOld) => {
      const oldSnapshot = deferred<RepoSnapshot>()
      const newSnapshot = deferred<RepoSnapshot>()
      const api = apiFor(
        vi.fn().mockReturnValueOnce(oldSnapshot.promise).mockReturnValueOnce(newSnapshot.promise),
      )
      const repository = new GitnaRepository(api)
      const loading = repository.refreshCurrentFolder()
      const cleanupA = repository.connectEvents()
      TestEventSource.current!.dispatch('open')
      cleanupA()
      const cleanupB = repository.connectEvents()
      TestEventSource.current!.dispatch('open')
      await vi.advanceTimersByTimeAsync(0)

      expect(api.snapshot).toHaveBeenCalledTimes(2)
      if (rejectOld) oldSnapshot.reject(new Error('old lifecycle'))
      else oldSnapshot.resolve(snapshot())
      await vi.advanceTimersByTimeAsync(0)
      expect(repository.connectionReady).toBe(false)

      newSnapshot.resolve(snapshot(2))
      await vi.advanceTimersByTimeAsync(0)
      await loading
      cleanupB()
    },
  )

  it.each([false, true])(
    'completes replacement reads without traversing a stale child (%s)',
    async (rejectOld) => {
      const oldRoot = deferred<{
        directory: string
        entries: Array<{
          kind: 'directory'
          name: string
          path: string
          hasChildren: true
        }>
        generation: number
        truncated: false
      }>()
      const api = apiFor(async () => snapshot())
      let rootRequests = 0
      let childRequests = 0
      api.directoryEntries = vi.fn().mockImplementation((directory: string) => {
        if (directory === '') {
          rootRequests += 1
          if (rootRequests === 1) {
            return Promise.resolve({
              directory: '',
              entries: [{ kind: 'directory', name: 'child', path: 'child/', hasChildren: true }],
              generation: 1,
              truncated: false,
            })
          }
          if (rootRequests === 2) return oldRoot.promise
          return Promise.resolve({
            directory: '',
            entries: [{ kind: 'directory', name: 'child', path: 'child/', hasChildren: true }],
            generation: 1,
            truncated: false,
          })
        }
        childRequests += 1
        return Promise.resolve({
          directory: 'child',
          entries: [{ kind: 'file', name: 'file', path: 'child/file' }],
          generation: 1,
          truncated: false,
        })
      })
      const repository = new GitnaRepository(api)
      await repository.refreshCurrentFolder()
      await repository.loadOrdinaryDirectory('child')
      expect(repository.repositoryPaths).toEqual(['child/', 'child/file'])

      const cleanupA = repository.connectEvents()
      const oldLoading = repository.refreshRepositoryFiles()
      await vi.waitFor(() => expect(rootRequests).toBe(2))

      cleanupA()
      const cleanupB = repository.connectEvents()
      TestEventSource.current!.dispatch('open')
      await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2))
      expect(rootRequests).toBe(2)

      const oldResponse = {
        directory: '',
        entries: [
          { kind: 'directory' as const, name: 'child', path: 'child/', hasChildren: true as const },
        ],
        generation: 1,
        truncated: false as const,
      }
      if (rejectOld) oldRoot.reject(new Error('old lifecycle'))
      else oldRoot.resolve(oldResponse)
      await oldLoading
      await vi.waitFor(() => expect(repository.connectionReady).toBe(true))

      expect(rootRequests).toBe(3)
      expect(childRequests).toBe(2)
      expect(repository.repositoryPaths).toEqual(['child/', 'child/file'])
      cleanupB()
    },
  )

  it.each([false, true])(
    'does not publish a stale final generation error (%s)',
    async (rejectOldCount) => {
      const oldFinalCount = deferred<{ generation: number; total: number }>()
      const replacementSnapshot = deferred<RepoSnapshot>()
      let directoryGeneration = 1
      let countRequests = 0
      const snapshotApi = vi
        .fn()
        .mockResolvedValueOnce(snapshot(1, false))
        .mockResolvedValueOnce(snapshot(2, true))
        .mockReturnValueOnce(replacementSnapshot.promise)
      const api = apiFor(snapshotApi)
      api.repositoryFileCount = vi.fn((generation: number) => {
        countRequests += 1
        if (countRequests === 4) return oldFinalCount.promise
        return Promise.resolve({ generation, total: 1 })
      })
      api.directoryEntries = vi.fn(async (directory: string) => ({
        directory,
        entries: [{ kind: 'file' as const, name: 'file', path: 'file' }],
        generation: directoryGeneration,
        truncated: false as const,
      }))
      const repository = new GitnaRepository(api)
      await repository.refreshCurrentFolder()
      const cleanupA = repository.connectEvents()
      TestEventSource.current!.dispatch('open')
      TestEventSource.current!.dispatch('files-invalidated')
      await vi.advanceTimersByTimeAsync(150)
      await vi.waitFor(() => expect(countRequests).toBe(4))

      cleanupA()
      const cleanupB = repository.connectEvents()
      TestEventSource.current!.dispatch('open')
      await vi.waitFor(() => expect(snapshotApi).toHaveBeenCalledTimes(3))
      expect(repository.connectionReady).toBe(false)

      if (rejectOldCount) oldFinalCount.reject(new Error('old count'))
      else oldFinalCount.resolve({ generation: 2, total: 1 })
      await vi.advanceTimersByTimeAsync(0)
      expect(repository.repositoryFilesError).toBeNull()
      expect(repository.connectionReady).toBe(false)

      directoryGeneration = 3
      replacementSnapshot.resolve(snapshot(3, true))
      await vi.waitFor(() => expect(repository.connectionReady).toBe(true))
      expect(repository.repositoryFilesError).toBeNull()
      cleanupB()
    },
  )

  it.each([false, true])(
    'does not start an obsolete follow-on directory request (%s)',
    async (rejectOld) => {
      const oldRoot = deferred<{
        directory: string
        entries: Array<{
          kind: 'directory'
          name: string
          path: string
          hasChildren: true
        }>
        generation: number
        truncated: false
      }>()
      const api = apiFor(async () => snapshot())
      let rootRequests = 0
      let childRequests = 0
      api.directoryEntries = vi.fn().mockImplementation((directory: string) => {
        if (directory === '') {
          rootRequests += 1
          if (rootRequests === 1) {
            return Promise.resolve({
              directory: '',
              entries: [{ kind: 'directory', name: 'child', path: 'child/', hasChildren: true }],
              generation: 1,
              truncated: false,
            })
          }
          if (rootRequests === 2) return oldRoot.promise
          return Promise.resolve({
            directory: '',
            entries: [{ kind: 'file', name: 'stale', path: 'stale' }],
            generation: 1,
            truncated: false,
          })
        }
        childRequests += 1
        return Promise.resolve({
          directory: 'child',
          entries: [{ kind: 'file', name: 'file', path: 'child/file' }],
          generation: 1,
          truncated: false,
        })
      })
      const repository = new GitnaRepository(api)
      await repository.refreshCurrentFolder()
      await repository.loadOrdinaryDirectory('child')
      const originalPaths = [...repository.repositoryPaths]

      const cleanupA = repository.connectEvents()
      const oldLoading = repository.loadOrdinaryDirectory('', true)
      await vi.waitFor(() => expect(rootRequests).toBe(2))
      const waitingRefresh = repository.refreshRepositoryFiles()

      cleanupA()
      const cleanupB = repository.connectEvents()
      if (rejectOld) oldRoot.reject(new Error('old lifecycle'))
      else
        oldRoot.resolve({
          directory: '',
          entries: [{ kind: 'directory', name: 'child', path: 'child/', hasChildren: true }],
          generation: 1,
          truncated: false,
        })

      expect(await oldLoading).toBeNull()
      expect(await waitingRefresh).toBe('obsolete')
      expect(rootRequests).toBe(2)
      expect(childRequests).toBe(1)
      expect(repository.repositoryPaths).toEqual(originalPaths)
      cleanupB()
    },
  )

  it('does not acknowledge a replacement from an aborted initial root', async () => {
    const root = deferred<{
      directory: string
      entries: []
      generation: number
      truncated: false
    }>()
    const newSnapshot = deferred<RepoSnapshot>()
    const api = apiFor(
      vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(newSnapshot.promise),
    )
    api.directoryEntries = vi.fn().mockReturnValue(root.promise)
    const repository = new GitnaRepository(api)
    void repository.refreshCurrentFolder()
    const cleanupA = repository.connectEvents()
    TestEventSource.current!.dispatch('open')
    await vi.waitFor(() => expect(api.directoryEntries).toHaveBeenCalledTimes(1))

    cleanupA()
    const cleanupB = repository.connectEvents()
    TestEventSource.current!.dispatch('open')
    root.resolve({ directory: '', entries: [], generation: 1, truncated: false })
    await vi.advanceTimersByTimeAsync(0)

    expect(repository.connectionReady).toBe(false)
    newSnapshot.resolve(snapshot(2))
    cleanupB()
  })

  it('uses bounded recovery waits without a post-notice zero-delay storm', async () => {
    const api = apiFor(async () => snapshot())
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('error')

    await vi.advanceTimersByTimeAsync(999)
    expect(api.snapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(5)
    expect(TestEventSource.instances).toHaveLength(1)
    cleanup()
  })

  it('applies jitter endpoints and caps the final retry at fifteen seconds', async () => {
    vi.mocked(Math.random).mockReturnValue(1)
    const probeTimes: number[] = []
    const startTime = Date.now()
    const api = apiFor(async () => {
      probeTimes.push(Date.now())
      return snapshot()
    })
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('error')

    await vi.advanceTimersByTimeAsync(1_199)
    expect(api.snapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_400)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_800)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(9_600)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(probeTimes.map((time) => time - startTime)).toEqual([
      1_200, 3_600, 8_400, 18_000, 33_000,
    ])
    expect(probeTimes.slice(1).map((time, index) => time - probeTimes[index]!)).toEqual([
      2_400, 4_800, 9_600, 15_000,
    ])
    cleanup()
  })

  it('notifies the outage threshold while a diagnostic read is pending', async () => {
    const probe = deferred<RepoSnapshot>()
    const api = apiFor(() => probe.promise)
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('error')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_000)

    expect(repository.connectionState).toBe('unreachable')
    expect(repository.connectionError).toBe('Backend unreachable')
    probe.resolve(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('assigns the next retry from probe settlement time', async () => {
    const first = deferred<RepoSnapshot>()
    let reads = 0
    const api = apiFor(() => {
      reads += 1
      return reads === 1 ? first.promise : Promise.resolve(snapshot())
    })
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('error')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    first.resolve(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it('uses the lower jitter endpoint without changing retry spacing', async () => {
    vi.mocked(Math.random).mockReturnValue(0)
    const probeTimes: number[] = []
    const startTime = Date.now()
    const api = apiFor(async () => {
      probeTimes.push(Date.now())
      return snapshot()
    })
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('error')

    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_600)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_200)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(6_400)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(12_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(probeTimes.map((time) => time - startTime)).toEqual([800, 2_400, 5_600, 12_000, 24_000])
    cleanup()
  })

  it('preserves the outage notice when manual retry joins a pending probe', async () => {
    const probe = deferred<RepoSnapshot>()
    const api = apiFor(() => probe.promise)
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('error')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    const retry = repository.retryConnection()
    await vi.advanceTimersByTimeAsync(8_999)
    expect(repository.connectionState).not.toBe('unreachable')
    await vi.advanceTimersByTimeAsync(1)
    expect(repository.connectionState).toBe('unreachable')
    probe.resolve(snapshot())
    await retry
    cleanup()
  })

  it.each([false, true])(
    'resets outage notice state on a new lifecycle (%s)',
    async (delivered) => {
      const api = apiFor(async () => snapshot())
      const repository = new GitnaRepository(api)
      const cleanupA = repository.connectEvents()
      const sourceA = TestEventSource.current!
      sourceA.dispatch('error')
      await vi.advanceTimersByTimeAsync(delivered ? 10_000 : 4_000)
      cleanupA()
      await vi.advanceTimersByTimeAsync(7_000)

      const cleanupB = repository.connectEvents()
      TestEventSource.current!.dispatch('error')
      await vi.advanceTimersByTimeAsync(9_999)
      expect(repository.connectionState).not.toBe('unreachable')
      await vi.advanceTimersByTimeAsync(1)
      expect(repository.connectionState).toBe('unreachable')
      cleanupB()
    },
  )

  it('does not let a scheduled probe continue into a replacement lifecycle', async () => {
    const probe = deferred<RepoSnapshot>()
    const api = apiFor(() => probe.promise)
    const repository = new GitnaRepository(api)
    const cleanupA = repository.connectEvents()
    const sourceA = TestEventSource.current!
    sourceA.dispatch('error')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(api.snapshot).toHaveBeenCalledTimes(1)

    cleanupA()
    const cleanupB = repository.connectEvents()
    probe.resolve(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    cleanupB()
  })

  it('replaces one still-current CLOSED source after a successful scheduled probe', async () => {
    const api = apiFor(async () => snapshot())
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('error')
    source.readyState = 2

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(TestEventSource.instances).toHaveLength(2)
    expect(source.closeCount).toBe(1)
    expect(TestEventSource.current).not.toBe(source)
    cleanup()
    expect(TestEventSource.instances[1]?.closeCount).toBe(1)
  })

  it('coalesces repeated manual replacement requests onto one new source', async () => {
    const probe = deferred<RepoSnapshot>()
    const api = apiFor(() => probe.promise)
    const repository = new GitnaRepository(api)
    const cleanup = repository.connectEvents()
    const source = TestEventSource.current!
    source.readyState = 2

    const first = repository.retryConnection()
    const second = repository.retryConnection()
    expect(TestEventSource.instances).toHaveLength(2)
    expect(source.closeCount).toBe(1)
    expect(api.snapshot).toHaveBeenCalledTimes(1)

    probe.resolve(snapshot())
    await Promise.all([first, second])
    expect(TestEventSource.instances).toHaveLength(2)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it.each(['graph', 'branches', 'remotes', 'stashes', 'tags'] as const)(
    'keeps %s catch-up failures reconciling with their operation reason',
    async (failedLoader) => {
      const api = apiFor(async () => snapshot())
      api[failedLoader] = vi.fn().mockRejectedValue(new Error(`${failedLoader} failed`))
      const repository = new GitnaRepository(api)
      const cleanup = repository.connectEvents()
      TestEventSource.current!.dispatch('open')
      await repository.refreshCurrentFolder()

      expect(repository.connectionState).toBe('reconciling')
      expect(repository.connectionError).toBe(`${failedLoader} failed`)
      cleanup()
    },
  )

  it('retains a directory failure when a sibling directory succeeds later', async () => {
    let rootRequests = 0
    const api = apiFor(async () => snapshot(1, false))
    api.directoryEntries = vi.fn().mockImplementation(async (directory: string) => {
      if (directory === '') {
        rootRequests += 1
        if (rootRequests > 1) throw new Error('root failed')
        return {
          directory: '',
          entries: [
            { kind: 'directory' as const, name: 'bad', path: 'bad/', hasChildren: true as const },
            { kind: 'directory' as const, name: 'good', path: 'good/', hasChildren: true as const },
          ],
          generation: 1,
          truncated: false as const,
        }
      }
      return {
        directory,
        entries: [{ kind: 'file' as const, name: 'file', path: `${directory}file` }],
        generation: 1,
        truncated: false as const,
      }
    })
    const repository = new GitnaRepository(api)
    await repository.refreshCurrentFolder()
    await repository.loadOrdinaryDirectory('good')

    const cleanup = repository.connectEvents()
    TestEventSource.current!.dispatch('open')
    await repository.refreshCurrentFolder()

    expect(repository.connectionState).toBe('reconciling')
    expect(repository.connectionError).toBe('root failed')
    expect(repository.ordinaryDirectoryErrors.get('')).toBe('root failed')
    cleanup()
  })
  it.each([false, true])(
    'bounds retained-deadline callbacks across error/open/error (%s)',
    async (reject) => {
      const pending = deferred<RepoSnapshot>()
      const api = apiFor(
        vi
          .fn()
          .mockResolvedValueOnce(snapshot())
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue(snapshot()),
      )
      const repo = new GitnaRepository(api)
      const loading = repo.refreshCurrentFolder()
      const cleanup = repo.connectEvents()
      const source = TestEventSource.current!
      source.dispatch('open')
      await loading
      const history: string[] = []
      repo.subscribe(() => history.push(repo.connectionState))
      source.dispatch('error')
      await vi.advanceTimersByTimeAsync(100)
      source.dispatch('open')
      await vi.advanceTimersByTimeAsync(100)
      source.dispatch('error')
      // Advance a bounded number of callbacks: a broken zero-delay scheduler
      // must fail this assertion, not hang the test runner.
      const timers = vi.spyOn(globalThis, 'setTimeout')
      for (let i = 0; i < 8 && !history.includes('unreachable'); i += 1) {
        await vi.advanceTimersToNextTimerAsync()
      }
      expect(history).toContain('unreachable')
      expect(timers.mock.calls.length).toBeLessThan(5)
      expect(api.snapshot).toHaveBeenCalledTimes(2)
      if (reject) pending.reject(new Error('old read failed'))
      else pending.resolve(snapshot())
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(999)
      expect(api.snapshot).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(api.snapshot).toHaveBeenCalledTimes(3)
      cleanup()
    },
  )

  it('preserves retries and original notice after CLOSED replacement stays CONNECTING', async () => {
    const api = apiFor(async () => snapshot())
    const repo = new GitnaRepository(api)
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('error')
    source.readyState = 2
    await vi.advanceTimersByTimeAsync(1_000)
    const replacement = TestEventSource.current!
    expect(replacement).not.toBe(source)
    expect(replacement.readyState).toBe(0)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(repo.connectionState).toBe('unreachable')
    expect(api.snapshot).toHaveBeenCalledTimes(3)
    expect(TestEventSource.instances).toHaveLength(2)
    cleanup()
    expect(source.closeCount).toBe(1)
    expect(replacement.closeCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('notifies while a manual-start probe is pending (%s)', async (reject) => {
    const pending = deferred<RepoSnapshot>()
    const api = apiFor(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot()))
    const repo = new GitnaRepository(api)
    const cleanup = repo.connectEvents()
    const history: string[] = []
    repo.subscribe(() => history.push(repo.connectionState))
    TestEventSource.current!.dispatch('error')
    await vi.advanceTimersByTimeAsync(500)
    const retry = repo.retryConnection()
    await vi.advanceTimersByTimeAsync(9_500)
    expect(history).toContain('unreachable')
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    if (reject) pending.reject(new Error('probe failed'))
    else pending.resolve(snapshot())
    await retry
    await vi.advanceTimersByTimeAsync(1_999)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it.each([
    'snapshot',
    'directoryEntries',
    'graph',
    'branches',
    'remotes',
    'stashes',
    'tags',
  ] as const)('retains provider-order %s failure through initial-open joining', async (loader) => {
    const pending = deferred<RepoSnapshot>()
    const api = apiFor(() => pending.promise)
    if (loader !== 'snapshot')
      api[loader] = vi.fn().mockRejectedValue(new Error(`${loader} captured`))
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    if (loader === 'snapshot') pending.reject(new Error('snapshot captured'))
    else pending.resolve(snapshot())
    await loading
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.connectionReady).toBe(false)
    expect(repo.connectionError).toBe(`${loader} captured`)
    cleanup()
  })

  it('captures a failed Graph before a sibling settles and a newer Graph clears its error', async () => {
    const tags = deferred<Awaited<ReturnType<ApiClient['tags']>>>()
    const api = apiFor(async () => snapshot())
    api.graph = vi
      .fn()
      .mockRejectedValueOnce(new Error('original graph failure'))
      .mockResolvedValue({ commits: [], hasMore: false, tip: '', generation: 1 })
    api.tags = vi.fn().mockReturnValue(tags.promise)
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.graphError).toBe('original graph failure')
    await repo.refreshGraph()
    expect(repo.graphError).toBeNull()
    tags.resolve([])
    await loading
    expect(repo.connectionError).toBe('original graph failure')
    expect(repo.connectionReady).toBe(false)
    cleanup()
  })

  it('captures Snapshot failure during generation reconciliation', async () => {
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce(snapshot(1, false))
        .mockRejectedValueOnce(new Error('generation snapshot failed')),
    )
    api.directoryEntries = vi
      .fn()
      .mockResolvedValue({ directory: '', entries: [], generation: 2, truncated: false })
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await loading
    expect(repo.connectionError).toBe('generation snapshot failed')
    expect(repo.connectionReady).toBe(false)
    cleanup()
  })

  it('drains branches/remotes before repeated manual retry can start another pair', async () => {
    const remotes = deferred<string[]>()
    const api = apiFor(async () => snapshot())
    api.branches = vi.fn().mockRejectedValue(new Error('branches failed'))
    api.remotes = vi.fn().mockReturnValue(remotes.promise)
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await vi.advanceTimersByTimeAsync(0)
    const first = repo.retryConnection()
    const second = repo.retryConnection()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.branches).toHaveBeenCalledTimes(1)
    expect(api.remotes).toHaveBeenCalledTimes(1)
    expect(repo.branchesLoading).toBe(true)
    remotes.resolve(['origin'])
    await Promise.all([loading, first, second])
    expect(repo.connectionError).toBe('branches failed')
    expect(repo.connectionReady).toBe(false)
    cleanup()
  })

  it('keeps catalog auxiliary and probes Snapshot-only', async () => {
    const catalog = deferred<Awaited<ReturnType<ApiClient['folders']>>>()
    const api = apiFor(async () => snapshot())
    api.folders = vi.fn().mockReturnValue(catalog.promise)
    const loaders = ['directoryEntries', 'graph', 'branches', 'remotes', 'stashes', 'tags'] as const
    for (const loader of loaders) vi.spyOn(api, loader)
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.connectionReady).toBe(true)
    await loading
    source.dispatch('snapshot-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    expect(api.folders).toHaveBeenCalledTimes(1)
    source.dispatch('error')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(api.snapshot).toHaveBeenCalledTimes(5)
    expect(api.folders).toHaveBeenCalledTimes(1)
    for (const loader of loaders) expect(api[loader]).toHaveBeenCalledTimes(1)
    expect(repo.connectionReady).toBe(false)
    catalog.resolve({ current: {} as never, recent: [] })
    cleanup()
  })

  it('loads resulting Git capability introduced during generation reconciliation', async () => {
    const api = apiFor(
      vi.fn().mockResolvedValueOnce(snapshot(1, false)).mockResolvedValue(snapshot(2, true)),
    )
    api.directoryEntries = vi
      .fn()
      .mockResolvedValue({ directory: '', entries: [], generation: 2, truncated: false })
    const gitLoaders = ['graph', 'branches', 'remotes', 'stashes', 'tags'] as const
    for (const loader of gitLoaders) vi.spyOn(api, loader)
    const tags = deferred<Awaited<ReturnType<ApiClient['tags']>>>()
    vi.mocked(api.tags).mockReturnValue(tags.promise)
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await vi.advanceTimersByTimeAsync(0)
    for (const loader of gitLoaders) expect(api[loader]).toHaveBeenCalledTimes(1)
    expect(repo.connectionReady).toBe(false)
    tags.resolve([])
    await loading
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  it.each([
    ['snapshot-invalidated', 'files-invalidated'],
    ['files-invalidated', 'snapshot-invalidated'],
    ['snapshot-invalidated', 'snapshot-invalidated'],
  ])(
    'unions requested scope and structural intent through coalescing %s / %s',
    async (first, second) => {
      const pending = deferred<RepoSnapshot>()
      const api = apiFor(
        vi
          .fn()
          .mockResolvedValueOnce(snapshot())
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue(snapshot(2)),
      )
      api.directoryEntries = vi
        .fn()
        .mockResolvedValue({ directory: '', entries: [], generation: 1, truncated: false })
      for (const loader of ['graph', 'branches', 'remotes', 'stashes', 'tags'] as const)
        vi.spyOn(api, loader)
      const repo = new GitnaRepository(api)
      const loading = repo.refreshCurrentFolder()
      const cleanup = repo.connectEvents()
      const source = TestEventSource.current!
      source.dispatch('open')
      await loading
      expect(repo.repositoryFileTotalGeneration).toBe(1)
      vi.mocked(api.repositoryFileCount).mockRejectedValue(new Error('auxiliary count failed'))
      vi.mocked(api.directoryEntries).mockResolvedValue({
        directory: '',
        entries: [],
        generation: 2,
        truncated: false,
      })
      source.dispatch(first)
      await vi.advanceTimersByTimeAsync(150)
      source.dispatch(second)
      await vi.advanceTimersByTimeAsync(150)
      pending.resolve(snapshot(2))
      await vi.advanceTimersByTimeAsync(0)
      const structural = first === 'files-invalidated' || second === 'files-invalidated'
      expect(repo.repositoryFileTotalGeneration).toBe(structural ? 1 : 2)
      expect(api.snapshot).toHaveBeenCalledTimes(3)
      expect(api.directoryEntries).toHaveBeenCalledTimes(structural ? 2 : 1)
      for (const loader of ['graph', 'branches', 'remotes', 'stashes', 'tags'] as const)
        expect(api[loader]).toHaveBeenCalledTimes(1)
      expect(api.folders).toHaveBeenCalledTimes(1)
      expect(repo.connectionReady).toBe(true)
      cleanup()
    },
  )

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'clears invalidated Git detail/comparison/conflict ownership (capability=%s, rejection=%s)',
    async (capabilityLoss, reject) => {
      const details = deferred<Awaited<ReturnType<ApiClient['commitFiles']>>>()
      const compare = deferred<Awaited<ReturnType<ApiClient['compare']>>>()
      const conflicts = deferred<Awaited<ReturnType<ApiClient['conflicts']>>>()
      const api = apiFor(
        vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot(2, false)),
      )
      api.commitFiles = vi
        .fn()
        .mockReturnValueOnce(details.promise)
        .mockResolvedValue({ files: [] })
      api.compare = vi.fn().mockReturnValue(compare.promise)
      api.conflicts = vi.fn().mockReturnValue(conflicts.promise)
      const repo = new GitnaRepository(api)
      await repo.refreshSnapshot()
      repo.repositoryOpenPaths = ['a', 'b']
      repo.repositoryFilePath = 'a'
      repo.repositoryFileComparison = { leftPath: 'a', rightPath: 'b', version: 0 }
      const worktreeComparison = repo.repositoryFileComparison
      const cleanup = repo.connectEvents()
      const pending = [
        repo.loadCommitDetails('old'),
        repo.openCompare('a', 'b', 'old'),
        repo.refreshConflicts(),
      ]
      if (capabilityLoss) await repo.refreshSnapshot()
      else TestEventSource.current!.dispatch('error')
      expect(repo.filesLoading).toEqual({})
      expect(repo.compareLoading).toBe(false)
      expect(repo.conflictsLoading).toBe(false)
      if (reject) {
        details.reject(new Error('obsolete detail failure'))
        compare.reject(new Error('obsolete comparison failure'))
        conflicts.reject(new Error('obsolete conflict failure'))
      } else {
        details.resolve({ files: [{ path: 'old', kind: 'modified' }] })
        compare.resolve({ files: [{ path: 'old', kind: 'modified' }] })
        conflicts.resolve([{ path: 'old' } as never])
      }
      await Promise.all(pending)
      expect(repo.commitFiles).toEqual({})
      expect(repo.filesError).toEqual({})
      expect(repo.compareFiles).toEqual([])
      expect(repo.compareError).toBeNull()
      expect(repo.conflicts).toEqual([])
      expect(repo.conflictsError).toBeNull()
      expect(repo.repositoryOpenPaths).toEqual(['a', 'b'])
      expect(repo.repositoryFilePath).toBe('a')
      expect(repo.repositoryFileComparison).toBe(worktreeComparison)
      if (capabilityLoss) expect(repo.compare).toBeNull()
      else {
        await repo.loadCommitDetails('old')
        expect(api.commitFiles).toHaveBeenCalledTimes(2)
      }
      cleanup()
    },
  )

  it('keeps a ref 403 distinct from a Snapshot session error', async () => {
    const api = apiFor(async () => snapshot())
    api.tags = vi.fn().mockRejectedValue(new ApiError(403, 'tag denied'))
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await loading
    expect(repo.connectionState).toBe('reconciling')
    expect(repo.connectionError).toBe('tag denied')
    cleanup()
  })

  it('retains captured authoritative failure across Snapshot-only success and pending full retry', async () => {
    const retry = deferred<RepoSnapshot>()
    const failure = new Error('tags unavailable')
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(retry.promise),
    )
    api.tags = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue([])
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    expect(repo.connectionError).toBe('tags unavailable')
    failure.message = 'mutated exception'
    repo.tagsError = 'mutable loader error'
    const reasons: Array<string | null> = []
    repo.subscribe(() => reasons.push(repo.connectionError))
    source.dispatch('snapshot-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    expect(repo.connectionReady).toBe(false)
    expect(repo.connectionError).toBe('tags unavailable')
    expect(api.tags).toHaveBeenCalledTimes(1)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(api.snapshot).toHaveBeenCalledTimes(3)
    expect(api.tags).toHaveBeenCalledTimes(1)
    expect(repo.connectionState).toBe('reconciling')
    expect(repo.connectionError).toBe('tags unavailable')
    expect(reasons.every((reason) => reason === 'tags unavailable')).toBe(true)
    retry.resolve(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.connectionReady).toBe(true)
    expect(repo.connectionError).toBeNull()
    expect(api.tags).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it.each([false, true])(
    'services queued Snapshot after superseded Graph settlement (%s)',
    async (reject) => {
      const graph = deferred<GraphPage>()
      const api = apiFor(async () => snapshot())
      const currentGraph: GraphPage = { commits: [], hasMore: false, tip: '', generation: 1 }
      api.graph = vi.fn().mockReturnValueOnce(graph.promise).mockResolvedValue(currentGraph)
      const repo = new GitnaRepository(api)
      const loading = repo.refreshCurrentFolder()
      const cleanup = repo.connectEvents()
      const source = TestEventSource.current!
      source.dispatch('open')
      await vi.advanceTimersByTimeAsync(0)
      source.dispatch('graph-invalidated')
      await vi.advanceTimersByTimeAsync(150)
      expect(api.graph).toHaveBeenCalledTimes(2)
      if (reject) graph.reject(new Error('superseded failure'))
      else graph.resolve({ ...currentGraph, tip: 'obsolete' })
      await loading
      expect(api.snapshot).toHaveBeenCalledTimes(2)
      expect(repo.graphTip).toBe('')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(repo.connectionReady).toBe(true)
      expect(api.snapshot).toHaveBeenCalledTimes(3)
      expect(api.graph).toHaveBeenCalledTimes(3)
      cleanup()
    },
  )

  it('retries an older Snapshot without acknowledging it or stranding open recovery', async () => {
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce(snapshot(2))
        .mockResolvedValueOnce(snapshot(1))
        .mockResolvedValue(snapshot(2)),
    )
    api.directoryEntries = vi
      .fn()
      .mockResolvedValue({ directory: '', entries: [], generation: 2, truncated: false })
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    const previous = repo.snapshot
    source.dispatch('error')
    source.dispatch('open')
    await vi.advanceTimersByTimeAsync(150)
    expect(repo.connectionReady).toBe(false)
    expect(repo.snapshot).toBe(previous)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(repo.connectionReady).toBe(true)
    expect(api.snapshot).toHaveBeenCalledTimes(3)
    expect(repo.snapshot).toBe(previous)
    cleanup()
  })

  it('does not certify a null/obsolete initial root and retries it', async () => {
    const api = apiFor(async () => snapshot(2, false))
    api.directoryEntries = vi
      .fn()
      .mockResolvedValueOnce({ directory: '', entries: [], generation: 1, truncated: false })
      .mockResolvedValue({ directory: '', entries: [], generation: 2, truncated: false })
    const repo = new GitnaRepository(api)
    // A previously observed tree generation makes the first root obsolete.
    await repo.loadOrdinaryDirectory('loaded')
    vi.mocked(api.directoryEntries).mockClear()
    vi.mocked(api.directoryEntries).mockResolvedValueOnce({
      directory: '',
      entries: [],
      generation: 0,
      truncated: false,
    })
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await loading
    expect(repo.connectionReady).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  it.each([403, 404])('classifies only captured Snapshot %s as session-error', async (status) => {
    const api = apiFor(async () => {
      throw new ApiError(status, 'route unavailable')
    })
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    TestEventSource.current!.dispatch('open')
    await loading
    expect(repo.connectionState).toBe('session-error')
    expect(repo.connectionError).toBe('route unavailable')
    expect(repo.connectionReady).toBe(false)
    cleanup()
  })

  it.each([false, true])(
    'Snapshot supersession releases conflict loading and errors (%s)',
    async (reject) => {
      const conflicts = deferred<Awaited<ReturnType<ApiClient['conflicts']>>>()
      const api = apiFor(async () => snapshot(2))
      api.conflicts = vi.fn().mockReturnValue(conflicts.promise)
      const repo = new GitnaRepository(api)
      const pending = repo.refreshConflicts()
      await repo.refreshSnapshot()
      expect(repo.conflictsLoading).toBe(false)
      expect(repo.conflictsError).toBeNull()
      if (reject) conflicts.reject(new Error('obsolete conflict failure'))
      else conflicts.resolve([{ path: 'obsolete' } as never])
      await pending
      expect(repo.conflicts).toEqual([])
      expect(repo.conflictsError).toBeNull()
    },
  )

  for (const loader of [
    'snapshot',
    'directoryEntries',
    'graph',
    'branches',
    'remotes',
    'stashes',
    'tags',
  ] as const) {
    it.each([false, true])(
      `fences late ${loader} publication and readiness after cleanup/setup (%s)`,
      async (reject) => {
        const pending = deferred<unknown>()
        const api = apiFor(async () => snapshot())
        const original = api[loader].bind(api)
        api[loader] = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(original)
        const repo = new GitnaRepository(api)
        const loading = repo.refreshCurrentFolder()
        const cleanupA = repo.connectEvents()
        TestEventSource.current!.dispatch('open')
        await vi.advanceTimersByTimeAsync(0)
        cleanupA()
        const cleanupB = repo.connectEvents()
        TestEventSource.current!.dispatch('open')
        const history: string[] = []
        repo.subscribe(() => history.push(repo.connectionState))
        await vi.advanceTimersByTimeAsync(0)
        if (reject) pending.reject(new Error('obsolete response'))
        else
          pending.resolve(
            loader === 'snapshot'
              ? snapshot(99)
              : loader === 'directoryEntries'
                ? {
                    directory: '',
                    entries: [{ kind: 'file', name: 'obsolete', path: 'obsolete' }],
                    generation: 99,
                    truncated: false,
                  }
                : loader === 'graph'
                  ? { commits: [], hasMore: false, tip: 'obsolete', generation: 99 }
                  : loader === 'remotes'
                    ? ['obsolete']
                    : [{ name: 'obsolete', ref: 'obsolete', oid: 'obsolete' }],
          )
        await loading
        await vi.advanceTimersByTimeAsync(0)
        expect(repo.connectionReady).toBe(true)
        expect(repo.generation).toBe(1)
        expect(repo.graphTip).not.toBe('obsolete')
        expect(repo.repositoryPaths).not.toContain('obsolete')
        expect(repo.branches).toEqual([])
        expect(repo.remotes).toEqual([])
        expect(repo.stashes).toEqual([])
        expect(repo.tags).toEqual([])
        expect(repo.connectionError).toBeNull()
        expect(history).not.toContain('unreachable')
        expect(api[loader]).toHaveBeenCalledTimes(2)
        cleanupA()
        expect(TestEventSource.current!.closeCount).toBe(0)
        cleanupB()
      },
    )
  }

  for (const manual of [false, true]) {
    it.each([false, true])(
      `fences ${manual ? 'manual' : 'scheduled'} probe settlement across lifecycle (%s)`,
      async (reject) => {
        const pending = deferred<RepoSnapshot>()
        const api = apiFor(() => pending.promise)
        const repo = new GitnaRepository(api)
        const cleanupA = repo.connectEvents()
        TestEventSource.current!.dispatch('error')
        let retry: Promise<void> | undefined
        if (manual) retry = repo.retryConnection()
        else await vi.advanceTimersByTimeAsync(1_000)
        cleanupA()
        const cleanupB = repo.connectEvents()
        const version = repo.getVersion()
        if (reject) pending.reject(new Error('obsolete probe'))
        else pending.resolve(snapshot())
        await retry
        await vi.advanceTimersByTimeAsync(20_000)
        expect(repo.getVersion()).toBe(version)
        expect(api.snapshot).toHaveBeenCalledTimes(1)
        expect(TestEventSource.instances).toHaveLength(2)
        expect(vi.getTimerCount()).toBe(0)
        cleanupB()
      },
    )
  }

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('refreshes every resulting capability loader (%s to %s)', async (before, after) => {
    const api = apiFor(
      vi.fn().mockResolvedValueOnce(snapshot(1, before)).mockResolvedValue(snapshot(2, after)),
    )
    const git = ['graph', 'branches', 'remotes', 'stashes', 'tags'] as const
    for (const loader of git) vi.spyOn(api, loader)
    api.directoryEntries = vi
      .fn()
      .mockResolvedValue({ directory: '', entries: [], generation: 1, truncated: false })
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    for (const loader of git) expect(api[loader]).toHaveBeenCalledTimes(before ? 1 : 0)
    const branches = [
      { name: 'current', oid: 'current', current: true, remote: false, ahead: 0, behind: 0 },
    ]
    const stashes = [{ ref: 'stash@{0}', oid: 'current', branch: 'main', message: 'current' }]
    const tags = [{ name: 'current', oid: 'current', annotated: false }]
    repo.branches = [{ ...branches[0]!, name: 'old' }]
    repo.remotes = ['old']
    repo.stashes = [{ ...stashes[0]!, oid: 'old' }]
    repo.tags = [{ ...tags[0]!, name: 'old' }]
    vi.mocked(api.branches).mockResolvedValue(branches)
    vi.mocked(api.remotes).mockResolvedValue(['origin'])
    vi.mocked(api.stashes).mockResolvedValue(stashes)
    vi.mocked(api.tags).mockResolvedValue(tags)
    vi.mocked(api.directoryEntries).mockResolvedValue({
      directory: '',
      entries: [],
      generation: 2,
      truncated: false,
    })
    source.dispatch('error')
    source.dispatch('open')
    await vi.advanceTimersByTimeAsync(150)
    for (const loader of git)
      expect(api[loader]).toHaveBeenCalledTimes(Number(before) + Number(after))
    expect(repo.branches).toEqual(after ? branches : [])
    expect(repo.remotes).toEqual(after ? ['origin'] : [])
    expect(repo.stashes).toEqual(after ? stashes : [])
    expect(repo.tags).toEqual(after ? tags : [])
    expect(api.directoryEntries).toHaveBeenCalledTimes(2)
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  for (const openAt of ['snapshot', 'fanout', 'settled'] as const) {
    it.each([false, true])(
      `acknowledges startup once with open at ${openAt}, Explorer first=%s`,
      async (explorerFirst) => {
        const snap = deferred<RepoSnapshot>()
        const root = deferred<DirectoryEntries>()
        const graph = deferred<GraphPage>()
        const api = apiFor(() => snap.promise)
        api.directoryEntries = vi.fn().mockReturnValue(root.promise)
        api.graph = vi.fn().mockReturnValue(graph.promise)
        const repo = new GitnaRepository(api)
        const loading = repo.refreshCurrentFolder()
        const cleanup = repo.connectEvents()
        const source = TestEventSource.current!
        const history: boolean[] = []
        repo.subscribe(() => history.push(repo.connectionReady))
        if (openAt === 'snapshot') source.dispatch('open')
        snap.resolve(snapshot())
        await vi.advanceTimersByTimeAsync(0)
        expect(repo.snapshot?.root).toBe('/repo')
        expect(api.graph).toHaveBeenCalledTimes(1)
        expect(api.directoryEntries).toHaveBeenCalledTimes(1)
        if (openAt === 'fanout') source.dispatch('open')
        const settleRoot = () =>
          root.resolve({
            directory: '',
            entries: [{ kind: 'file', name: 'ready', path: 'ready' }],
            generation: 1,
            truncated: false,
          })
        const settleGraph = () =>
          graph.resolve({ commits: [], hasMore: false, tip: '', generation: 1 })
        if (explorerFirst) settleRoot()
        else settleGraph()
        await vi.advanceTimersByTimeAsync(0)
        expect(history).not.toContain(true)
        if (explorerFirst) settleGraph()
        else settleRoot()
        await loading
        expect(repo.repositoryPaths).toEqual(['ready'])
        if (openAt === 'settled') {
          expect(repo.connectionReady).toBe(false)
          source.dispatch('open')
        }
        expect(repo.connectionReady).toBe(true)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(api.snapshot).toHaveBeenCalledTimes(1)
        expect(api.directoryEntries).toHaveBeenCalledTimes(1)
        expect(api.graph).toHaveBeenCalledTimes(1)
        expect(api.folders).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
        cleanup()
      },
    )
  }

  it('captures a healthy graph-invalidated failure without amplifying its loader scope', async () => {
    const api = apiFor(async () => snapshot())
    const current = { commits: [], hasMore: false, tip: '', generation: 1 }
    api.graph = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error('event graph failed'))
      .mockResolvedValue(current)
    for (const loader of ['directoryEntries', 'branches', 'remotes', 'stashes', 'tags'] as const)
      vi.spyOn(api, loader)
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    source.dispatch('graph-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    expect(repo.connectionReady).toBe(false)
    expect(repo.connectionError).toBe('event graph failed')
    expect(api.graph).toHaveBeenCalledTimes(2)
    for (const loader of ['directoryEntries', 'branches', 'remotes', 'stashes', 'tags'] as const)
      expect(api[loader]).toHaveBeenCalledTimes(1)
    expect(api.folders).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  it('keeps equal-generation Snapshot and selection identities during full recovery', async () => {
    const snap = snapshot()
    snap.unstaged = [
      { path: 'a', kind: 'modified', scope: 'unstaged', staged: false, conflicted: false },
    ]
    const api = apiFor(async () => ({ ...snap, unstaged: [...snap.unstaged] }))
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    repo.select('unstaged', 'a')
    const previous = repo.snapshot
    const selection = repo.selection
    source.dispatch('error')
    source.dispatch('open')
    await vi.advanceTimersByTimeAsync(150)
    expect(repo.connectionReady).toBe(true)
    expect(repo.snapshot).toBe(previous)
    expect(repo.selection).toBe(selection)
    cleanup()
  })

  it('does not probe a successfully loaded initial folder while awaiting its first open', async () => {
    const api = apiFor(async () => snapshot())
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    await loading
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(repo.connectionReady).toBe(false)
    TestEventSource.current!.dispatch('open')
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  it.each([false, true])(
    'keeps manual joins bounded and fences their obsolete settlement (%s)',
    async (reject) => {
      const pending = deferred<RepoSnapshot>()
      const api = apiFor(() => pending.promise)
      const repo = new GitnaRepository(api)
      const cleanupA = repo.connectEvents()
      TestEventSource.current!.dispatch('error')
      await vi.advanceTimersByTimeAsync(1_000)
      const joins = [repo.retryConnection(), repo.retryConnection()]
      await vi.advanceTimersByTimeAsync(9_000)
      expect(repo.connectionState).toBe('unreachable')
      expect(api.snapshot).toHaveBeenCalledTimes(1)
      cleanupA()
      const cleanupB = repo.connectEvents()
      const version = repo.getVersion()
      if (reject) pending.reject(new Error('old joined read'))
      else pending.resolve(snapshot())
      await Promise.all(joins)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(repo.getVersion()).toBe(version)
      expect(api.snapshot).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      cleanupB()
    },
  )

  it('never publishes the historical unreachable transition after reopen with a failed ref and pending retry', async () => {
    const pending = deferred<RepoSnapshot>()
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(pending.promise),
    )
    api.tags = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('tags unavailable'))
      .mockResolvedValue([])
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    source.dispatch('error')
    await vi.advanceTimersByTimeAsync(300)
    source.dispatch('open')
    const history: string[] = []
    repo.subscribe(() => history.push(repo.connectionState))
    await vi.advanceTimersByTimeAsync(150)
    expect(repo.connectionError).toBe('tags unavailable')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(api.snapshot).toHaveBeenCalledTimes(3)
    expect(history).not.toContain('unreachable')
    expect(repo.connectionState).toBe('reconciling')
    expect(repo.connectionError).toBe('tags unavailable')
    pending.resolve(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  it.each([false, true])(
    'does not publish late auxiliary count finalizers after teardown (%s)',
    async (reject) => {
      const count = deferred<Awaited<ReturnType<ApiClient['graphCount']>>>()
      const api = apiFor(async () => snapshot())
      api.graph = vi
        .fn()
        .mockResolvedValue({ commits: [], hasMore: false, tip: 'tip', generation: 1 })
      api.graphCount = vi.fn().mockReturnValue(count.promise)
      const repo = new GitnaRepository(api)
      const cleanupA = repo.connectEvents()
      await repo.refreshGraph()
      cleanupA()
      const cleanupB = repo.connectEvents()
      const version = repo.getVersion()
      if (reject) count.reject(new ApiError(409, 'old count'))
      else count.resolve({ tip: 'tip', generation: 1, total: 100 })
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.getVersion()).toBe(version)
      expect(repo.graphTotal).toBeNull()
      expect(repo.graphCountLoading).toBe(false)
      expect(api.graph).toHaveBeenCalledTimes(1)
      cleanupB()
    },
  )

  it.each([false, true])(
    'preserves captured branch-pair failure while sibling later settles (%s)',
    async (rejectSibling) => {
      const remote = deferred<string[]>()
      const failure = new Error('captured branch reason')
      const api = apiFor(async () => snapshot())
      api.branches = vi.fn().mockRejectedValue(failure)
      api.remotes = vi.fn().mockReturnValue(remote.promise)
      const repo = new GitnaRepository(api)
      const loading = repo.refreshCurrentFolder()
      const cleanup = repo.connectEvents()
      TestEventSource.current!.dispatch('open')
      await vi.advanceTimersByTimeAsync(0)
      failure.message = 'mutated after branch completion'
      if (rejectSibling) remote.reject(new Error('remote failed later'))
      else remote.resolve(['origin'])
      await loading
      expect(repo.connectionError).toBe('captured branch reason')
      expect(repo.connectionReady).toBe(false)
      cleanup()
    },
  )

  it('strengthens pending Snapshot membership on files-invalidated receipt before its coalescer fires', async () => {
    const pending = deferred<RepoSnapshot>()
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(snapshot(2)),
    )
    api.directoryEntries = vi
      .fn()
      .mockResolvedValue({ directory: '', entries: [], generation: 1, truncated: false })
    for (const loader of ['graph', 'branches', 'remotes', 'stashes', 'tags'] as const)
      vi.spyOn(api, loader)
    const repo = new GitnaRepository(api)
    const loading = repo.refreshCurrentFolder()
    const cleanup = repo.connectEvents()
    const source = TestEventSource.current!
    source.dispatch('open')
    await loading
    expect([repo.repositoryFileTotal, repo.repositoryFileTotalGeneration]).toEqual([12, 1])
    vi.mocked(api.repositoryFileCount).mockRejectedValue(new Error('auxiliary count failed'))
    vi.mocked(api.directoryEntries).mockResolvedValue({
      directory: '',
      entries: [],
      generation: 2,
      truncated: false,
    })
    source.dispatch('snapshot-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10)
    source.dispatch('files-invalidated')
    await vi.advanceTimersByTimeAsync(10)
    pending.resolve(snapshot(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.generation).toBe(2)
    expect([repo.repositoryFileTotal, repo.repositoryFileTotalGeneration]).toEqual([12, 1])
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(api.directoryEntries).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(139)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect([repo.repositoryFileTotal, repo.repositoryFileTotalGeneration]).toEqual([12, 1])
    expect(repo.generation).toBe(2)
    expect(api.snapshot).toHaveBeenCalledTimes(3)
    expect(api.directoryEntries).toHaveBeenCalledTimes(2)
    expect(api.repositoryFileCount).toHaveBeenCalledTimes(2)
    for (const loader of ['graph', 'branches', 'remotes', 'stashes', 'tags'] as const)
      expect(api[loader]).toHaveBeenCalledTimes(1)
    expect(api.folders).toHaveBeenCalledTimes(1)
    expect(repo.connectionReady).toBe(true)
    cleanup()
  })

  for (const replacement of ['failure', 'empty', 'cached', 'pending-count'] as const) {
    it.each([false, true])(
      `releases superseded Graph count ownership for ${replacement} (%s)`,
      async (reject) => {
        const oldCount = deferred<Awaited<ReturnType<ApiClient['graphCount']>>>()
        const currentCount = deferred<Awaited<ReturnType<ApiClient['graphCount']>>>()
        const replacementGraph = deferred<GraphPage>()
        const api = apiFor(async () => snapshot())
        api.graph = vi
          .fn()
          .mockResolvedValueOnce({ commits: [], hasMore: false, tip: 'cached', generation: 1 })
          .mockResolvedValueOnce({ commits: [], hasMore: false, tip: 'old', generation: 1 })
          .mockReturnValueOnce(replacementGraph.promise)
        api.graphCount = vi
          .fn()
          .mockResolvedValueOnce({ tip: 'cached', generation: 1, total: 7 })
          .mockReturnValueOnce(oldCount.promise)
          .mockReturnValueOnce(currentCount.promise)
        const repo = new GitnaRepository(api)
        await repo.refreshGraph()
        await vi.advanceTimersByTimeAsync(0)
        expect(repo.graphTotal).toBe(7)
        await repo.refreshGraph()
        expect(repo.graphCountLoading).toBe(true)
        const pending = repo.refreshGraph()
        expect(vi.mocked(api.graphCount).mock.calls[1]![2]!.aborted).toBe(true)
        expect(repo.graphCountLoading).toBe(false)
        if (replacement === 'failure')
          replacementGraph.reject(new Error('current Graph unavailable'))
        else
          replacementGraph.resolve({
            commits: [],
            hasMore: false,
            tip: replacement === 'empty' ? '' : replacement === 'cached' ? 'cached' : 'current',
            generation: 1,
          })
        await pending
        expect(repo.graphCountLoading).toBe(replacement === 'pending-count')
        const version = repo.getVersion()
        if (reject) oldCount.reject(new ApiError(409, 'obsolete count'))
        else oldCount.resolve({ tip: 'old', generation: 1, total: 100 })
        await vi.advanceTimersByTimeAsync(0)
        expect(repo.getVersion()).toBe(version)
        expect(repo.graphCountLoading).toBe(replacement === 'pending-count')
        expect(repo.graphTotal).toBe(
          replacement === 'empty' ? 0 : replacement === 'cached' ? 7 : null,
        )
        expect(repo.graphError).toBe(replacement === 'failure' ? 'current Graph unavailable' : null)
        expect(api.graph).toHaveBeenCalledTimes(3)
        expect(api.graphCount).toHaveBeenCalledTimes(replacement === 'pending-count' ? 3 : 2)
        if (replacement === 'pending-count') {
          expect(vi.mocked(api.graphCount).mock.calls[2]![2]!.aborted).toBe(false)
          currentCount.resolve({ tip: 'current', generation: 1, total: 9 })
          await vi.advanceTimersByTimeAsync(0)
          expect(repo.graphCountLoading).toBe(false)
          expect(repo.graphTotal).toBe(9)
        }
      },
    )
  }

  for (const loader of [
    'snapshot',
    'directoryEntries',
    'graph',
    'branches',
    'remotes',
    'stashes',
    'tags',
  ] as const) {
    it.each([false, true])(
      `fences late ${loader} across transport error/reopen until current readiness (%s)`,
      async (reject) => {
        const old = deferred<unknown>()
        const current = deferred<unknown>()
        const api = apiFor(async () => snapshot(2))
        api.directoryEntries = vi
          .fn()
          .mockResolvedValue({ directory: '', entries: [], generation: 2, truncated: false })
        api.graph = vi
          .fn()
          .mockResolvedValue({ commits: [], hasMore: false, tip: '', generation: 2 })
        for (const name of ['branches', 'remotes', 'stashes', 'tags'] as const) vi.spyOn(api, name)
        api[loader] = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
        const repo = new GitnaRepository(api)
        const loading = repo.refreshCurrentFolder()
        const cleanup = repo.connectEvents()
        const source = TestEventSource.current!
        source.dispatch('open')
        await vi.advanceTimersByTimeAsync(0)
        expect(api[loader]).toHaveBeenCalledTimes(1)
        source.dispatch('error')
        source.dispatch('open')
        const readiness: boolean[] = []
        const obsoletePublications: boolean[] = []
        repo.subscribe(() => {
          readiness.push(repo.connectionReady)
          obsoletePublications.push(
            repo.generation === 99 ||
              repo.graphTip === 'obsolete' ||
              repo.repositoryPaths.includes('obsolete') ||
              JSON.stringify([
                repo.branches,
                repo.remotes,
                repo.stashes,
                repo.tags,
                repo.connectionError,
                repo.error,
                repo.graphError,
                repo.repositoryFilesError,
                repo.branchesError,
                repo.stashesError,
                repo.tagsError,
              ]).includes('obsolete'),
          )
        })
        await vi.advanceTimersByTimeAsync(150)
        expect(repo.connectionReady).toBe(false)
        if (reject) old.reject(new Error('obsolete response'))
        else
          old.resolve(
            loader === 'snapshot'
              ? snapshot(99)
              : loader === 'directoryEntries'
                ? {
                    directory: '',
                    entries: [{ kind: 'file', name: 'obsolete', path: 'obsolete' }],
                    generation: 99,
                    truncated: false,
                  }
                : loader === 'graph'
                  ? { commits: [], hasMore: false, tip: 'obsolete', generation: 99 }
                  : loader === 'remotes'
                    ? ['obsolete']
                    : [{ name: 'obsolete', ref: 'obsolete', oid: 'obsolete' }],
          )
        await vi.advanceTimersByTimeAsync(0)
        expect(api[loader]).toHaveBeenCalledTimes(2)
        expect(repo.connectionReady).toBe(false)
        expect(readiness).not.toContain(true)
        current.resolve(
          loader === 'snapshot'
            ? snapshot(2)
            : loader === 'directoryEntries'
              ? { directory: '', entries: [], generation: 2, truncated: false }
              : loader === 'graph'
                ? { commits: [], hasMore: false, tip: '', generation: 2 }
                : [],
        )
        await loading
        await vi.advanceTimersByTimeAsync(0)
        expect(repo.connectionReady).toBe(true)
        expect(readiness.at(-1)).toBe(true)
        expect(obsoletePublications).not.toContain(true)
        expect(repo.connectionError).toBeNull()
        expect(repo.generation).toBe(2)
        expect(repo.graphTip).toBe('')
        expect(repo.repositoryPaths).toEqual([])
        expect([repo.branches, repo.remotes, repo.stashes, repo.tags]).toEqual([[], [], [], []])
        expect(api.snapshot).toHaveBeenCalledTimes(2)
        expect(api[loader]).toHaveBeenCalledTimes(2)
        expect(TestEventSource.current).toBe(source)
        expect(TestEventSource.instances).toHaveLength(1)
        expect(source.closeCount).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        cleanup()
      },
    )
  }
})
