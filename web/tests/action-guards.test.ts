import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionGuardError, GitnaRepository } from '../src/diffshub/gitna/repository'
import type { ApiClient } from '../src/lib/api'
import type { RepoSnapshot } from '../src/lib/types'

function snapshot(repository = false, generation = 1): RepoSnapshot {
  return {
    appVersion: 'dev',
    repository,
    root: '/repo',
    headOid: 'abc123',
    headBranch: 'main',
    ahead: 0,
    behind: 0,
    operation: 'none',
    staged: [],
    unstaged: [],
    generation,
  }
}

function api(overrides: Record<string, unknown> = {}): ApiClient {
  return {
    snapshot: vi.fn(async () => snapshot()),
    folders: vi.fn(async () => ({ current: {}, recent: [] })),
    repositoryFiles: vi.fn(async () => ({ generation: 1, paths: [], truncated: false })),
    repositoryFileCount: vi.fn(async (generation: number) => ({ generation, total: 0 })),
    directoryEntries: vi.fn(async (directory: string) => ({
      directory,
      entries: [],
      generation: 1,
      truncated: false,
    })),
    searchFiles: vi.fn(async () => ({ generation: 1, results: [], complete: true })),
    readWorktreeFile: vi.fn(),
    compareWorktreeFiles: vi.fn(),
    writeWorktreeFile: vi.fn(async () => ({ path: 'file.txt', content: 'saved', hash: 'hash' })),
    createWorktreeEntry: vi.fn(async () => undefined),
    renameWorktreeEntry: vi.fn(async () => undefined),
    diff: vi.fn(),
    review: vi.fn(),
    mutate: vi.fn(async () => undefined),
    commit: vi.fn(async () => ({ ok: true })),
    graph: vi.fn(async () => ({ commits: [], hasMore: false, tip: '', generation: 1 })),
    graphCount: vi.fn(async () => ({ tip: '', generation: 1, total: 0 })),
    commitFiles: vi.fn(),
    branches: vi.fn(async () => []),
    remotes: vi.fn(async () => []),
    stashes: vi.fn(async () => []),
    tags: vi.fn(async () => []),
    compare: vi.fn(),
    conflicts: vi.fn(async () => []),
    openFolder: vi.fn(async (path: string) => ({ root: path, href: '../folder/' })),
    removeRecentFolder: vi.fn(async () => undefined),
    revealFolder: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ApiClient
}

const connectionCleanups: Array<() => void> = []

class TestEventSource {
  static current: TestEventSource | null = null
  readyState = 0
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor() {
    TestEventSource.current = this
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  dispatch(type: string): void {
    if (type === 'open') this.readyState = 1
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  close(): void {
    this.readyState = 2
  }
}

const API_ENDPOINTS = [
  'snapshot',
  'folders',
  'repositoryFiles',
  'repositoryFileCount',
  'directoryEntries',
  'searchFiles',
  'readWorktreeFile',
  'compareWorktreeFiles',
  'writeWorktreeFile',
  'createWorktreeEntry',
  'renameWorktreeEntry',
  'diff',
  'review',
  'mutate',
  'commit',
  'graph',
  'graphCount',
  'commitFiles',
  'branches',
  'remotes',
  'stashes',
  'tags',
  'compare',
  'conflicts',
  'openFolder',
  'removeRecentFolder',
  'revealFolder',
] as const

type DirectCommand = () => Promise<unknown>

function directCommands(repository: GitnaRepository): DirectCommand[] {
  return [
    () => repository.mutate({ op: 'stage', paths: ['file.txt'] }),
    () => repository.operation({ op: 'fetch' }),
    () => repository.commit('subject'),
    () => repository.saveWorktreeFile('file.txt', 'content', 'hash'),
    () => repository.createWorktreeEntry('file.txt', false),
    () => repository.createWorktreeEntry('folder/', true),
    () => repository.renameWorktreeEntry('old.txt', 'new.txt'),
    () => repository.removeRecentFolder('/old'),
    () => repository.revealFolder(),
  ]
}

function endpointCounts(client: ApiClient): Record<string, number> {
  return Object.fromEntries(
    API_ENDPOINTS.map((name) => [
      name,
      (client as unknown as Record<string, { mock?: { calls: unknown[][] } }>)[name]?.mock?.calls
        .length ?? 0,
    ]),
  )
}

function expectNoEndpointDelta(before: Record<string, number>, client: ApiClient): void {
  expect(endpointCounts(client)).toEqual(before)
}

function refusalState(repository: GitnaRepository) {
  return {
    snapshot: repository.snapshot,
    folders: repository.folders,
    selection: repository.selection,
    filePath: repository.repositoryFilePath,
    openPaths: repository.repositoryOpenPaths,
    selectedPaths: repository.repositorySelectedPaths,
    comparison: repository.repositoryFileComparison,
    comparisonActive: repository.repositoryFileComparisonActive,
    compare: repository.compare,
    rename: repository.worktreeRename,
    busy: repository.busy,
    activeOp: repository.activeOp,
  }
}

function expectRefusalState(repository: GitnaRepository, before: ReturnType<typeof refusalState>) {
  const after = refusalState(repository)
  for (const key of Object.keys(before) as Array<keyof typeof before>) {
    expect(after[key], key).toBe(before[key])
  }
}

function setBlockedSentinels(repository: GitnaRepository): void {
  repository.snapshot = snapshot(true)
  repository.folders = {
    current: { path: '/repo', name: 'repo', repository: true, lastOpened: '' },
    recent: [],
  }
  repository.selection = {
    scope: 'unstaged',
    change: {
      path: 'file.txt',
      kind: 'modified',
      scope: 'unstaged',
      staged: false,
      conflicted: false,
    },
  }
  repository.repositoryFilePath = 'file.txt'
  repository.repositoryOpenPaths = ['file.txt', 'old.txt']
  repository.repositorySelectedPaths = ['file.txt', 'old.txt']
  repository.repositoryFileComparison = {
    leftPath: 'file.txt',
    rightPath: 'old.txt',
    version: 8,
  }
  repository.repositoryFileComparisonActive = true
  repository.compare = { from: 'abc123', to: 'def456', label: 'comparison' }
  repository.worktreeRename = { source: 'old.txt', destination: 'new.txt', version: 4 }
}

async function readyRepository(client: ApiClient): Promise<{
  repository: GitnaRepository
  cleanup: () => void
}> {
  const repository = new GitnaRepository(client)
  const loading = repository.refreshCurrentFolder()
  const cleanup = repository.connectEvents()
  // Register ownership before awaiting startup or making an assertion. This
  // keeps failed setup paths from leaking an EventSource into later tests.
  connectionCleanups.push(cleanup)
  TestEventSource.current?.dispatch('open')
  await loading
  expect(repository.connectionReady).toBe(true)
  return { repository, cleanup }
}

describe('GitnaRepository action guards', () => {
  beforeEach(() => {
    TestEventSource.current = null
    connectionCleanups.length = 0
    vi.stubGlobal('EventSource', TestEventSource)
  })

  afterEach(() => {
    for (const cleanup of connectionCleanups.splice(0).reverse()) cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports truthful reasons with busy and disposal precedence', async () => {
    const repository = new GitnaRepository(api())
    expect(repository.getActionDisabledReason()).toBe(
      'Connecting to backend. Wait for connection and refresh to complete.',
    )
    expect(repository.getActionDisabledReason('open-folder')).toBeNull()

    repository.connectionState = 'reconnecting'
    expect(repository.getActionDisabledReason()).toBe(
      'Backend connection interrupted. Wait for reconnection or refresh to retry.',
    )
    repository.connectionState = 'reconciling'
    repository.connectionError = 'Snapshot failed'
    expect(repository.getActionDisabledReason()).toBe(
      'Refreshing backend state. Wait for refresh to complete. Snapshot failed Refresh to retry.',
    )
    repository.connectionState = 'unreachable'
    expect(repository.getActionDisabledReason()).toBe(
      'Backend unreachable. Retry the connection or reopen Gitna.',
    )
    repository.connectionState = 'session-error'
    repository.connectionError = 'Session expired'
    expect(repository.getActionDisabledReason()).toBe(
      'Backend session error. Reopen Gitna using its current URL. Session expired',
    )

    repository.busy = true
    repository.activeOp = 'commit'
    expect(repository.getActionDisabledReason()).toBe(
      'Another operation is in progress (Committing). Wait for it to finish.',
    )
    expect(repository.getActionDisabledReason('open-folder')).toContain('Committing')

    const connected = await readyRepository(api())
    expect(connected.repository.getActionDisabledReason()).toBeNull()
    const version = connected.repository.getVersion()
    expect(connected.repository.getActionDisabledReason()).toBeNull()
    expect(connected.repository.getVersion()).toBe(version)
    connected.cleanup()
    expect(connected.repository.getActionDisabledReason()).toBe(
      'This repository view is closed. Reopen Gitna to continue.',
    )
  })

  it('covers every direct seam across blocked, connected-busy, and disposed states', async () => {
    const blockedStates = [
      'connecting',
      'reconnecting',
      'reconciling',
      'unreachable',
      'session-error',
    ] as const
    for (const stateName of blockedStates) {
      const client = api()
      const repository = new GitnaRepository(client)
      repository.connectionState = stateName
      repository.connectionError = stateName === 'reconciling' ? 'catch-up failed' : null
      setBlockedSentinels(repository)
      const before = refusalState(repository)
      const counts = endpointCounts(client)
      const reason = repository.getActionDisabledReason()!
      for (const command of directCommands(repository)) {
        await expect(command()).rejects.toMatchObject({ name: 'ActionGuardError', message: reason })
      }
      expectNoEndpointDelta(counts, client)
      expectRefusalState(repository, before)
      expect(repository.mutationError).toBe(reason)
    }

    const pendingRelease = (() => {
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      return { pending, release }
    })()
    const busyClient = api({ mutate: vi.fn(() => pendingRelease.pending) })
    const busyReady = await readyRepository(busyClient)
    setBlockedSentinels(busyReady.repository)
    const first = busyReady.repository.operation({ op: 'push' })
    await Promise.resolve()
    const busyCounts = endpointCounts(busyClient)
    const busyBefore = refusalState(busyReady.repository)
    const busyReason = busyReady.repository.getActionDisabledReason()!
    for (const command of directCommands(busyReady.repository)) {
      await expect(command()).rejects.toMatchObject({
        name: 'ActionGuardError',
        message: busyReason,
      })
    }
    expectNoEndpointDelta(busyCounts, busyClient)
    expectRefusalState(busyReady.repository, busyBefore)
    expect(busyReady.repository.mutationError).toBe(busyReason)
    expect(busyReady.repository.busy).toBe(true)
    expect(busyReady.repository.activeOp).toBe('push')
    pendingRelease.release()
    await first

    const disposedClient = api()
    const disposedReady = await readyRepository(disposedClient)
    setBlockedSentinels(disposedReady.repository)
    disposedReady.cleanup()
    const disposedCounts = endpointCounts(disposedClient)
    const disposedBefore = refusalState(disposedReady.repository)
    const disposedReason = disposedReady.repository.getActionDisabledReason()!
    expect(disposedReason).toContain('repository view is closed')
    for (const command of directCommands(disposedReady.repository)) {
      await expect(command()).rejects.toMatchObject({
        name: 'ActionGuardError',
        message: disposedReason,
      })
    }
    expectNoEndpointDelta(disposedCounts, disposedClient)
    expectRefusalState(disposedReady.repository, disposedBefore)
    expect(disposedReady.repository.mutationError).toBe(disposedReason)
    expect(disposedReady.repository.busy).toBe(false)
    expect(disposedReady.repository.activeOp).toBeNull()
    expect(disposedReady.repository.snapshot).not.toBeNull()
    expect(disposedReady.repository.repositoryFilePath).toBe('file.txt')
    expect(disposedReady.repository.repositoryFileComparison).toEqual({
      leftPath: 'file.txt',
      rightPath: 'old.txt',
      version: 8,
    })
  })

  it('forwards open-folder cancellation during failed initial Snapshot without changing state', async () => {
    const ordinaryFailure = new Error('ordinary route failure')
    const abortFailure = new Error('route aborted')
    const abortSignal = new AbortController()
    const openFolder = vi.fn(async (path: string, signal?: AbortSignal) => {
      if (path === '/ordinary-failure') throw ordinaryFailure
      if (path === '/abort-failure') {
        expect(signal).toBe(abortSignal.signal)
        if (signal?.aborted) throw abortFailure
        throw new Error('abort signal was not forwarded')
      }
      return { root: path, href: '../folder/' }
    })
    let snapshotCalls = 0
    const client = api({
      openFolder,
      snapshot: vi.fn(async () => {
        snapshotCalls += 1
        throw new Error('initial Snapshot failed')
      }),
    })
    const repository = new GitnaRepository(client)
    setBlockedSentinels(repository)
    const loading = repository.refreshCurrentFolder()
    const cleanup = repository.connectEvents()
    connectionCleanups.push(cleanup)
    TestEventSource.current?.dispatch('open')
    await loading
    const before = {
      snapshot: repository.snapshot,
      folders: repository.folders,
      selection: repository.selection,
      filePath: repository.repositoryFilePath,
      openPaths: repository.repositoryOpenPaths,
      selectedPaths: repository.repositorySelectedPaths,
      comparison: repository.repositoryFileComparison,
      rename: repository.worktreeRename,
      busy: repository.busy,
      activeOp: repository.activeOp,
      error: repository.error,
      mutationError: repository.mutationError,
    }
    const success = await repository.openFolder('/success')
    expect(success).toEqual({ root: '/success', href: '../folder/' })
    await expect(repository.openFolder('/ordinary-failure')).rejects.toBe(ordinaryFailure)
    abortSignal.abort()
    await expect(repository.openFolder('/abort-failure', abortSignal.signal)).rejects.toBe(
      abortFailure,
    )
    expect(openFolder).toHaveBeenCalledWith('/abort-failure', abortSignal.signal)
    expect(snapshotCalls).toBe(1)
    expect(repository.snapshot).toBe(before.snapshot)
    expect(repository.folders).toBe(before.folders)
    expect(repository.selection).toBe(before.selection)
    expect(repository.repositoryFilePath).toBe(before.filePath)
    expect(repository.repositoryOpenPaths).toBe(before.openPaths)
    expect(repository.repositorySelectedPaths).toBe(before.selectedPaths)
    expect(repository.repositoryFileComparison).toBe(before.comparison)
    expect(repository.worktreeRename).toBe(before.rename)
    expect(repository.busy).toBe(before.busy)
    expect(repository.activeOp).toBe(before.activeOp)
    expect(repository.error).toBe(before.error)
    expect(repository.mutationError).toBe(before.mutationError)

    repository.busy = true
    await expect(repository.openFolder('/busy')).rejects.toThrow(ActionGuardError)
    repository.busy = false
    cleanup()
    await expect(repository.openFolder('/closed')).rejects.toThrow(
      'This repository view is closed. Reopen Gitna to continue.',
    )
    expect(openFolder).toHaveBeenCalledTimes(3)
  })

  it.each(['connecting', 'reconnecting', 'reconciling', 'unreachable', 'session-error'] as const)(
    'refuses every seam across the blocked %s state without changing local state',
    async (stateName) => {
      const client = api()
      const repository = new GitnaRepository(client)
      repository.connectionState = stateName
      repository.connectionError = stateName === 'reconciling' ? 'catch-up failed' : null
      repository.snapshot = snapshot(true)
      repository.folders = {
        current: { path: '/repo', name: 'repo', repository: true, lastOpened: '' },
        recent: [],
      }
      repository.selection = {
        scope: 'unstaged',
        change: {
          path: 'file.txt',
          kind: 'modified',
          scope: 'unstaged',
          staged: false,
          conflicted: false,
        },
      }
      repository.repositoryOpenPaths = ['file.txt']
      repository.repositorySelectedPaths = ['file.txt']
      repository.compare = { from: 'abc123', to: 'def456', label: 'comparison' }
      repository.worktreeRename = { source: 'old.txt', destination: 'new.txt', version: 4 }
      const before = {
        snapshot: repository.snapshot,
        folders: repository.folders,
        selection: repository.selection,
        openPaths: repository.repositoryOpenPaths,
        selectedPaths: repository.repositorySelectedPaths,
        compare: repository.compare,
        rename: repository.worktreeRename,
        version: repository.getVersion(),
      }
      const reason = repository.getActionDisabledReason()!
      const commands = [
        () => repository.mutate({ op: 'stage', paths: ['file.txt'] }),
        () => repository.operation({ op: 'fetch' }),
        () => repository.commit('subject'),
        () => repository.saveWorktreeFile('file.txt', 'content', 'hash'),
        () => repository.createWorktreeEntry('file.txt', false),
        () => repository.createWorktreeEntry('folder/', true),
        () => repository.renameWorktreeEntry('old.txt', 'new.txt'),
        () => repository.removeRecentFolder('/old'),
        () => repository.revealFolder(),
      ]

      for (const command of commands) {
        await expect(command()).rejects.toMatchObject({ name: 'ActionGuardError', message: reason })
      }

      expect(client.mutate).not.toHaveBeenCalled()
      expect(client.commit).not.toHaveBeenCalled()
      expect(client.writeWorktreeFile).not.toHaveBeenCalled()
      expect(client.createWorktreeEntry).not.toHaveBeenCalled()
      expect(client.renameWorktreeEntry).not.toHaveBeenCalled()
      expect(client.removeRecentFolder).not.toHaveBeenCalled()
      expect(client.revealFolder).not.toHaveBeenCalled()
      expect(repository.busy).toBe(false)
      expect(repository.activeOp).toBeNull()
      expect(repository.snapshot).toBe(before.snapshot)
      expect(repository.folders).toBe(before.folders)
      expect(repository.selection).toBe(before.selection)
      expect(repository.repositoryOpenPaths).toBe(before.openPaths)
      expect(repository.repositorySelectedPaths).toBe(before.selectedPaths)
      expect(repository.compare).toBe(before.compare)
      expect(repository.worktreeRename).toBe(before.rename)
      expect(repository.getVersion()).toBe(before.version + 7)
      expect(repository.mutationError).toBe(reason)
    },
  )

  it('keeps folder and reveal refusal errors caller-owned and publishes mutation refusal before rejection', async () => {
    const client = api()
    const repository = new GitnaRepository(client)
    repository.mutationError = 'existing mutation error'
    const notify = vi.fn()
    repository.subscribe(notify)
    const mutation = repository.mutate({ op: 'stage', paths: ['file.txt'] })
    expect(repository.mutationError).toBe(repository.getActionDisabledReason())
    expect(notify).toHaveBeenCalled()
    await expect(mutation).rejects.toBeInstanceOf(ActionGuardError)
    expect(repository.mutationError).toContain('Connecting')

    repository.mutationError = 'existing mutation error'
    await expect(repository.revealFolder()).rejects.toBeInstanceOf(ActionGuardError)
    await expect(repository.removeRecentFolder('/old')).rejects.toBeInstanceOf(ActionGuardError)
    expect(repository.mutationError).toBe('existing mutation error')
    expect(client.revealFolder).not.toHaveBeenCalled()
    expect(client.removeRecentFolder).not.toHaveBeenCalled()
  })

  it('routes every named Git wrapper through the same guarded operation seam', async () => {
    const repository = new GitnaRepository(api())
    const wrappers: Array<() => Promise<unknown>> = [
      () => repository.createBranch('topic', 'main'),
      () => repository.switchBranch('main'),
      () => repository.deleteBranch('topic', true),
      () => repository.fetchRemote(),
      () => repository.pullRemote(),
      () => repository.pushRemote(),
      () => repository.pushSetUpstream('origin', 'topic'),
      () => repository.stashPush('wip', true),
      () => repository.stashApply('stash@{0}'),
      () => repository.stashPop('stash@{0}'),
      () => repository.stashDrop('stash@{0}'),
      () => repository.createTag('v1', 'HEAD', 'release'),
      () => repository.deleteTag('v1'),
      () => repository.pushTag('origin', 'v1'),
      () => repository.cherryPick('abc123'),
      () => repository.cherryPickAbort(),
      () => repository.cherryPickContinue(),
      () => repository.revertCommit('abc123'),
      () => repository.revertAbort(),
      () => repository.revertContinue(),
      () => repository.resetTo('HEAD', 'hard'),
      () => repository.mergeBranch('main'),
      () => repository.mergeAbort(),
      () => repository.mergeContinue(),
      () => repository.rebaseBranch('main'),
      () => repository.rebaseAbort(),
      () => repository.rebaseContinue(),
      () => repository.resolveOurs('file.txt'),
      () => repository.resolveTheirs('file.txt'),
      () => repository.resolveBoth('file.txt'),
    ]
    for (const wrapper of wrappers) await expect(wrapper()).rejects.toBeInstanceOf(ActionGuardError)
    expect(repository.api.mutate as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('admits only after a real failed initial Snapshot recovers, without replaying refused work', async () => {
    let failSnapshot = true
    const mutate = vi.fn(async () => undefined)
    const client = api({
      mutate,
      snapshot: vi.fn(async () => {
        if (failSnapshot) throw new Error('initial Snapshot failed')
        return snapshot()
      }),
    })
    const repository = new GitnaRepository(client)
    const loading = repository.refreshCurrentFolder()
    const cleanup = repository.connectEvents()
    connectionCleanups.push(cleanup)
    TestEventSource.current?.dispatch('open')
    await loading
    expect(repository.connectionReady).toBe(false)
    await expect(repository.mutate({ op: 'stage', paths: ['file.txt'] })).rejects.toBeInstanceOf(
      ActionGuardError,
    )
    expect(mutate).not.toHaveBeenCalled()

    failSnapshot = false
    await repository.retryConnection()
    expect(repository.connectionReady).toBe(true)
    await repository.mutate({ op: 'stage', paths: ['file.txt'] })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('requires real Git ref catch-up after a successful Snapshot before admitting work', async () => {
    vi.useFakeTimers()
    let failBranches = false
    let snapshotCalls = 0
    const branches = vi.fn(async () => {
      if (failBranches) throw new Error('branches catch-up failed')
      return []
    })
    const client = api({
      branches,
      snapshot: vi.fn(async () => {
        snapshotCalls += 1
        if (snapshotCalls === 2) return snapshot(false, 2)
        return snapshot(true, snapshotCalls)
      }),
      directoryEntries: vi.fn(async (directory: string) => ({
        directory,
        entries: [],
        generation: Math.max(snapshotCalls, 1),
        truncated: false,
      })),
    })
    const { repository } = await readyRepository(client)
    const source = TestEventSource.current!
    const startupBranches = branches.mock.calls.length
    failBranches = true
    // The capability transition ordinary -> Git makes reconciliation run the
    // authoritative graph/ref fan-out rather than merely rereading Snapshot.
    source.dispatch('snapshot-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    await Promise.resolve()
    expect(repository.snapshot?.repository).toBe(false)
    source.dispatch('snapshot-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    await Promise.resolve()
    expect(repository.snapshot?.repository).toBe(true)
    expect(branches.mock.calls.length).toBeGreaterThan(startupBranches)
    expect(repository.connectionState).toBe('reconciling')
    expect(repository.getActionDisabledReason()).toContain('Refreshing backend state')
    await expect(repository.operation({ op: 'fetch' })).rejects.toBeInstanceOf(ActionGuardError)
    expect(client.mutate).not.toHaveBeenCalled()

    failBranches = false
    await repository.retryConnection()
    expect(repository.connectionReady).toBe(true)
    await repository.operation({ op: 'fetch' })
    expect(client.mutate).toHaveBeenCalledTimes(1)
  })

  it('refuses during deferred reconciling Snapshot and does not replay after recovery', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const deferred = new Promise<RepoSnapshot>((resolve) => {
      release = () => resolve({ ...snapshot(), generation: 2 })
    })
    const client = api({
      snapshot: vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(deferred),
    })
    const { repository } = await readyRepository(client)
    const source = TestEventSource.current!
    source.dispatch('snapshot-invalidated')
    await vi.advanceTimersByTimeAsync(150)
    expect(repository.connectionState).toBe('reconciling')
    await expect(repository.operation({ op: 'push' })).rejects.toBeInstanceOf(ActionGuardError)
    expect(client.mutate).not.toHaveBeenCalled()
    release()
    await vi.runAllTimersAsync()
    expect(repository.connectionReady).toBe(true)
    expect(client.mutate).not.toHaveBeenCalled()
  })

  it('keeps reads and retry available while repository file opening is blocked', async () => {
    const client = api({
      snapshot: vi.fn(async () => snapshot()),
      folders: vi.fn(async () => ({ current: {}, recent: [] })),
    })
    const repository = new GitnaRepository(client)
    repository.connectionState = 'unreachable'
    repository.repositoryPaths = ['file.txt']
    repository.selectRepositoryFile('file.txt')
    expect(repository.repositoryFilePath).toBeNull()
    await repository.refreshSnapshot()
    await repository.refreshFolders()
    const cleanup = repository.connectEvents()
    connectionCleanups.push(cleanup)
    await repository.retryNow()
    expect(client.snapshot).toHaveBeenCalled()
    expect(client.folders).toHaveBeenCalled()
    expect(client.mutate).not.toHaveBeenCalled()
    expect(repository.repositoryFilePath).toBeNull()
  })

  it('dispatches ready save/create/rename and settles worktree busy ownership', async () => {
    let release!: () => void
    const saved = { path: 'file.txt', content: 'saved', hash: 'server-hash' }
    const pendingSave = new Promise<typeof saved>((resolve) => {
      release = () => resolve(saved)
    })
    const client = api({
      writeWorktreeFile: vi.fn(() => pendingSave),
      createWorktreeEntry: vi.fn(async () => undefined),
      renameWorktreeEntry: vi.fn(async () => undefined),
    })
    const { repository } = await readyRepository(client)
    const save = repository.saveWorktreeFile('file.txt', 'saved', 'old-hash')
    await Promise.resolve()
    expect(repository.busy).toBe(true)
    expect(repository.activeOp).toBe('save-file')
    release()
    await expect(save).resolves.toBe(saved)
    expect(repository.busy).toBe(false)
    await repository.createWorktreeEntry('new.txt', false)
    await repository.createWorktreeEntry('new-folder/', true)
    repository.repositoryOpenPaths = ['old.txt']
    await repository.renameWorktreeEntry('old.txt', 'new.txt')
    expect(client.createWorktreeEntry).toHaveBeenNthCalledWith(1, 'new.txt', false)
    expect(client.createWorktreeEntry).toHaveBeenNthCalledWith(2, 'new-folder/', true)
    expect(client.renameWorktreeEntry).toHaveBeenCalledWith('old.txt', 'new.txt')
    expect(repository.worktreeRename).toMatchObject({ source: 'old.txt', destination: 'new.txt' })
    expect(repository.repositoryOpenPaths).toEqual(['new.txt'])
  })

  it.each([false, true])(
    'keeps filesystem actions busy through follow-up reads (Git=%s)',
    async (isGit) => {
      const actions: Array<{
        label: string
        endpoint: 'writeWorktreeFile' | 'createWorktreeEntry' | 'renameWorktreeEntry'
        run: (repository: GitnaRepository) => Promise<unknown>
      }> = [
        {
          label: 'save-file',
          endpoint: 'writeWorktreeFile',
          run: (repository) => repository.saveWorktreeFile('file.txt', 'saved', 'old-hash'),
        },
        {
          label: 'create-entry',
          endpoint: 'createWorktreeEntry',
          run: (repository) => repository.createWorktreeEntry('new.txt', false),
        },
        {
          label: 'create-entry',
          endpoint: 'createWorktreeEntry',
          run: (repository) => repository.createWorktreeEntry('new-folder/', true),
        },
        {
          label: 'rename-entry',
          endpoint: 'renameWorktreeEntry',
          run: (repository) => repository.renameWorktreeEntry('old.txt', 'new.txt'),
        },
      ]
      for (const action of actions) {
        const client = api({ snapshot: vi.fn(async () => snapshot(isGit)) })
        const { repository, cleanup } = await readyRepository(client)
        let release!: (value: RepoSnapshot) => void
        const followup = new Promise<RepoSnapshot>((resolve) => {
          release = resolve
        })
        let notifyStarted!: () => void
        const started = new Promise<void>((resolve) => {
          notifyStarted = resolve
        })
        vi.mocked(client.snapshot).mockImplementationOnce(() => {
          notifyStarted()
          return followup
        })
        let settled = false
        const running = action.run(repository).then((result) => {
          settled = true
          return result
        })
        await started
        expect(client[action.endpoint]).toHaveBeenCalledTimes(1)
        expect(client.snapshot).toHaveBeenCalledTimes(2)
        expect(settled).toBe(false)
        expect(repository.busy).toBe(true)
        expect(repository.activeOp).toBe(action.label)
        release(snapshot(isGit))
        await running
        expect(settled).toBe(true)
        expect(repository.busy).toBe(false)
        expect(repository.activeOp).toBeNull()
        expect(client[action.endpoint]).toHaveBeenCalledTimes(1)
        cleanup()
      }
    },
  )

  it('dispatches filesystem save/create/rename for Git and ordinary folders', async () => {
    const saved = { path: 'file.txt', content: 'saved', hash: 'server-hash' }
    const gitClient = api({
      snapshot: vi.fn(async () => snapshot(true)),
      writeWorktreeFile: vi.fn(async () => saved),
      createWorktreeEntry: vi.fn(async () => undefined),
      renameWorktreeEntry: vi.fn(async () => undefined),
    })
    const { repository: git } = await readyRepository(gitClient)
    git.repositoryOpenPaths = ['old.txt']
    git.repositoryFilePath = 'old.txt'
    git.repositorySelectedPaths = ['old.txt', 'keep.txt']
    git.repositoryFileComparison = { leftPath: 'old.txt', rightPath: 'keep.txt', version: 2 }
    git.repositoryFileComparisonActive = true
    const gitSaved = await git.saveWorktreeFile('file.txt', 'saved', 'old-hash')
    await git.createWorktreeEntry('new.txt', false)
    await git.createWorktreeEntry('new-folder/', true)
    await git.renameWorktreeEntry('old.txt', 'new.txt')
    expect(gitSaved).toBe(saved)
    expect(gitClient.writeWorktreeFile).toHaveBeenCalledTimes(1)
    expect(gitClient.createWorktreeEntry).toHaveBeenCalledTimes(2)
    expect(gitClient.renameWorktreeEntry).toHaveBeenCalledTimes(1)
    expect(gitClient.writeWorktreeFile).toHaveBeenCalledWith('file.txt', 'saved', 'old-hash')
    expect(gitClient.createWorktreeEntry).toHaveBeenNthCalledWith(1, 'new.txt', false)
    expect(gitClient.createWorktreeEntry).toHaveBeenNthCalledWith(2, 'new-folder/', true)
    expect(gitClient.renameWorktreeEntry).toHaveBeenCalledWith('old.txt', 'new.txt')
    expect(git.repositoryFilePath).toBe('new.txt')
    expect(git.repositoryOpenPaths).toEqual(['new.txt'])
    expect(git.repositorySelectedPaths).toEqual(['new.txt', 'keep.txt'])
    expect(git.repositoryFileComparison).toEqual({
      leftPath: 'new.txt',
      rightPath: 'keep.txt',
      version: 3,
    })
    expect(git.worktreeRename).toMatchObject({ source: 'old.txt', destination: 'new.txt' })

    const ordinaryClient = api({
      snapshot: vi.fn(async () => snapshot(false)),
      writeWorktreeFile: vi.fn(async () => saved),
      createWorktreeEntry: vi.fn(async () => undefined),
      renameWorktreeEntry: vi.fn(async () => undefined),
    })
    const { repository: ordinary } = await readyRepository(ordinaryClient)
    const gitReadBefore = endpointCounts(ordinaryClient)
    await expect(ordinary.saveWorktreeFile('file.txt', 'saved', 'old-hash')).resolves.toBe(saved)
    await ordinary.createWorktreeEntry('new.txt', false)
    await ordinary.renameWorktreeEntry('old.txt', 'new.txt')
    expect(ordinaryClient.writeWorktreeFile).toHaveBeenCalledTimes(1)
    expect(ordinaryClient.createWorktreeEntry).toHaveBeenCalledTimes(1)
    expect(ordinaryClient.renameWorktreeEntry).toHaveBeenCalledTimes(1)
    expect(ordinaryClient.writeWorktreeFile).toHaveBeenCalledWith('file.txt', 'saved', 'old-hash')
    expect(ordinaryClient.createWorktreeEntry).toHaveBeenCalledWith('new.txt', false)
    expect(ordinaryClient.renameWorktreeEntry).toHaveBeenCalledWith('old.txt', 'new.txt')
    for (const endpoint of [
      'graph',
      'graphCount',
      'branches',
      'remotes',
      'stashes',
      'tags',
      'conflicts',
    ]) {
      expect(endpointCounts(ordinaryClient)[endpoint]).toBe(gitReadBefore[endpoint])
    }
  })

  it('proves refused awaited continuations stop at the store rejection', async () => {
    const client = api()
    const repository = new GitnaRepository(client)
    let commitMessage = 'keep this message'
    const refusedCommit = repository.commit(commitMessage)
    const commitError = await refusedCommit.catch((error) => error)
    await expect(refusedCommit).rejects.toBe(commitError)
    expect(commitError).toBeInstanceOf(ActionGuardError)
    expect(repository.mutationError).toBe(commitError.message)
    // Promise/store proof of the await boundary; this is not React callback execution.
    let commitCleared = false
    try {
      await repository.commit(commitMessage)
      commitCleared = true
      commitMessage = ''
    } catch {
      // The caller retains its message after refusal.
    }
    expect(commitCleared).toBe(false)
    expect(commitMessage).toBe('keep this message')

    const savedBaseline = { path: 'file.txt', content: 'old', hash: 'old-hash' }
    let baseline = savedBaseline
    const draft = 'new content'
    const refusedSave = repository.saveWorktreeFile('file.txt', draft, savedBaseline.hash)
    const saveError = await refusedSave.catch((error) => error)
    await expect(refusedSave).rejects.toBe(saveError)
    try {
      const saved = await refusedSave
      baseline = saved
    } catch {
      // A refused save cannot publish a saved baseline.
    }
    expect(baseline).toBe(savedBaseline)
    expect(client.writeWorktreeFile).not.toHaveBeenCalled()

    const deleteCalls: unknown[] = []
    const refusedDiscard = repository.mutate({ op: 'discard', paths: ['tracked.txt'] })
    const discardError = await refusedDiscard.catch((error) => error)
    const discardThenDelete = async (): Promise<void> => {
      await refusedDiscard
      deleteCalls.push(await repository.mutate({ op: 'delete', paths: ['untracked.txt'] }))
    }
    await expect(discardThenDelete()).rejects.toBe(discardError)
    expect(deleteCalls).toHaveLength(0)
    expect(client.mutate).not.toHaveBeenCalled()
  })

  it('does not replay a dispatched API failure during transport recovery', async () => {
    vi.useFakeTimers()
    const failure = new Error('transport lost after dispatch')
    const mutate = vi.fn(async () => {
      throw failure
    })
    const client = api({ mutate, snapshot: vi.fn(async () => snapshot(true)) })
    const { repository } = await readyRepository(client)
    await expect(repository.operation({ op: 'push' })).rejects.toBe(failure)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(repository.busy).toBe(false)

    const source = TestEventSource.current!
    source.dispatch('error')
    expect(repository.connectionReady).toBe(false)
    source.dispatch('open')
    await repository.retryConnection()
    expect(repository.connectionReady).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('preserves the actual saved response identity and success dispatch arguments', async () => {
    const saved = { path: 'file.txt', content: 'saved', hash: 'server-hash' }
    const client = api({ writeWorktreeFile: vi.fn(async () => saved) })
    const { repository } = await readyRepository(client)
    await expect(repository.saveWorktreeFile('file.txt', 'saved', 'old-hash')).resolves.toBe(saved)
    expect(client.writeWorktreeFile).toHaveBeenCalledWith('file.txt', 'saved', 'old-hash')
  })

  it('binds each named Graph and Stage-edited callback to its own catch', () => {
    const source = readFileSync(
      new URL('../src/diffshub/gitna/SourceControlWorkflow.tsx', import.meta.url),
      'utf8',
    )
    const graphActions = [
      ['cherry-pick', "op: 'cherry-pick'"],
      ['revert', "op: 'revert'"],
      ['reset soft', "op: 'reset', ref: row.commit.oid, mode: 'soft'"],
      ['reset mixed', "op: 'reset', ref: row.commit.oid, mode: 'mixed'"],
    ] as const
    for (const [name, operation] of graphActions) {
      const operationIndex = source.indexOf(operation)
      expect(operationIndex, `${name} operation exists`).toBeGreaterThan(-1)
      const start = source.lastIndexOf('<DropdownMenuItem', operationIndex)
      const end = source.indexOf('</DropdownMenuItem>', operationIndex)
      const region = source.slice(start, end)
      expect(region, `${name} callback has its own terminal catch`).toContain('.catch(() => {')
      expect(region).toContain(operation)
      expect(region).toContain('The store has already published the mutation error.')
    }
    const stageLabel = source.indexOf('Stage edited')
    const stageStart = source.lastIndexOf('<Button', stageLabel)
    const stageEnd = source.indexOf('</Button>', stageLabel)
    const stageRegion = source.slice(stageStart, stageEnd)
    expect(stageRegion).toContain("mutate({ op: 'stage', paths: [conflict.path] })")
    expect(stageRegion).toContain('.catch((error) => onError(message(error)))')
  })

  it('proves terminal consumption and conflict forwarding retain one real refusal reason', async () => {
    const repository = new GitnaRepository(api())
    const terminalReason = repository.getActionDisabledReason()!
    const terminalPromise = repository.operation({ op: 'push' })
    await terminalPromise.catch(() => undefined)
    expect(repository.mutationError).toBe(terminalReason)
    await expect(terminalPromise).rejects.toMatchObject({
      name: 'ActionGuardError',
      message: terminalReason,
    })

    const forwarded = vi.fn()
    const forwardingPromise = repository.mutate({ op: 'stage', paths: ['file.txt'] })
    await forwardingPromise.catch((error) => forwarded(error.message))
    expect(forwarded).toHaveBeenCalledTimes(1)
    expect(forwarded).toHaveBeenCalledWith(terminalReason)
    expect(repository.mutationError).toBe(terminalReason)
  })

  it('dispatches admitted work once and keeps competing work out of the active slot', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = api({ mutate: vi.fn(() => pending) })
    const { repository, cleanup } = await readyRepository(client)

    const first = repository.operation({ op: 'push' })
    await Promise.resolve()
    expect(repository.busy).toBe(true)
    expect(repository.activeOp).toBe('push')
    await expect(repository.commit('blocked')).rejects.toBeInstanceOf(ActionGuardError)
    expect(repository.busy).toBe(true)
    expect(repository.activeOp).toBe('push')
    expect(client.commit).not.toHaveBeenCalled()

    release()
    await first
    expect(client.mutate).toHaveBeenCalledTimes(1)
    expect(client.mutate).toHaveBeenCalledWith({ op: 'push' })
    expect(repository.busy).toBe(false)
    expect(repository.activeOp).toBeNull()
    cleanup()
  })
})
