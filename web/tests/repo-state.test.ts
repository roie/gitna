import { describe, expect, it, vi } from 'vitest'
import { coalesce, createRepoState, reconcileSelection } from '../src/lib/repo-state.svelte'
import type { ApiClient } from '../src/lib/api'
import type { ChangeScope, FileChange, RepoSnapshot } from '../src/lib/types'

function change(scope: ChangeScope, path: string, kind: FileChange['kind'] = 'modified'): FileChange {
  return {
    path,
    kind,
    scope,
    staged: scope === 'staged',
    conflicted: false,
  }
}

function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    root: '/tmp/repo',
    headOid: 'abc123',
    headBranch: 'main',
    ahead: 0,
    behind: 0,
    operation: 'none',
    staged: [],
    unstaged: [],
    generation: 1,
    ...overrides,
  }
}

function queuedApi(snapshots: RepoSnapshot[]): ApiClient {
  let i = 0
  return {
    async snapshot() {
      const snapshot = snapshots[Math.min(i, snapshots.length - 1)]!
      i += 1
      return snapshot
    },
    async diff() {
      throw new Error('diff not used in repo-state tests')
    },
    async mutate() {
      throw new Error('mutate not used in queuedApi tests')
    },
    async commit() {
      throw new Error('commit not used in queuedApi tests')
    },
  }
}

describe('reconcileSelection', () => {
  const staged = [change('staged', 'a.txt'), change('staged', 'c.txt')]
  const unstaged = [change('unstaged', 'b.txt')]

  it('retains a selection whose path still exists, recomputed from the new snapshot', () => {
    const prev = { scope: 'staged' as ChangeScope, change: change('staged', 'a.txt') }
    const next = reconcileSelection(prev, staged, unstaged)
    expect(next?.scope).toBe('staged')
    expect(next?.change.path).toBe('a.txt')
    expect(next?.change).toBe(staged[0])
  })

  it('selects the nearest remaining change when the selected path disappears', () => {
    const prev = { scope: 'staged' as ChangeScope, change: change('staged', 'a0.txt') }
    const next = reconcileSelection(prev, staged, unstaged)
    // Combined order is [a.txt, c.txt, b.txt]; first entry >= a0.txt is c.txt.
    expect(next?.change.path).toBe('c.txt')
  })

  it('falls back to the last remaining change when the target sorts after everything', () => {
    const prev = { scope: 'staged' as ChangeScope, change: change('staged', 'z.txt') }
    const next = reconcileSelection(prev, staged, unstaged)
    expect(next?.change.path).toBe('b.txt')
  })

  it('clears the selection when no changes remain', () => {
    const prev = { scope: 'staged' as ChangeScope, change: change('staged', 'a.txt') }
    expect(reconcileSelection(prev, [], [])).toBeNull()
  })

  it('keeps the selection scope when the path survives in its own scope', () => {
    const prev = { scope: 'unstaged' as ChangeScope, change: change('unstaged', 'b.txt') }
    const next = reconcileSelection(prev, staged, unstaged)
    expect(next?.scope).toBe('unstaged')
  })
})

describe('createRepoState', () => {
  it('loads a snapshot and reconciles the selection after refresh', async () => {
    const api = queuedApi([
      snapshot({
        generation: 1,
        unstaged: [change('unstaged', 'x.txt'), change('unstaged', 'y.txt')],
      }),
    ])
    const state = createRepoState({ api })

    await state.refreshSnapshot()
    state.select('unstaged', 'x.txt')

    expect(state.snapshot?.headBranch).toBe('main')
    expect(state.generation).toBe(1)
    expect(state.loading).toBe(false)
    expect(state.selectedChange?.path).toBe('x.txt')
    expect(state.selectedChange?.scope).toBe('unstaged')
  })

  it('ignores stale responses whose generation is not newer', async () => {
    const api = queuedApi([
      snapshot({ generation: 2, unstaged: [change('unstaged', 'first.txt')] }),
      snapshot({ generation: 1, unstaged: [change('unstaged', 'stale.txt')] }),
    ])
    const state = createRepoState({ api })

    await state.refreshSnapshot()
    await state.refreshSnapshot()

    expect(state.generation).toBe(2)
    expect(state.snapshot?.unstaged[0]?.path).toBe('first.txt')
  })

  it('clears selection with select(scope, null)', async () => {
    const api = queuedApi([
      snapshot({ generation: 1, unstaged: [change('unstaged', 'x.txt')] }),
    ])
    const state = createRepoState({ api })

    await state.refreshSnapshot()
    state.select('unstaged', 'x.txt')
    expect(state.selectedChange?.path).toBe('x.txt')

    state.select('unstaged', null)
    expect(state.selectedChange).toBeNull()
  })

  it('reconciles toward the nearest change after a refresh removes the selection', async () => {
    const api = queuedApi([
      snapshot({
        generation: 1,
        unstaged: [change('unstaged', 'a.txt'), change('unstaged', 'b.txt')],
      }),
      snapshot({ generation: 2, unstaged: [change('unstaged', 'a.txt')] }),
    ])
    const state = createRepoState({ api })

    await state.refreshSnapshot()
    state.select('unstaged', 'b.txt')
    await state.refreshSnapshot()

    expect(state.selectedChange?.path).toBe('a.txt')
  })

  it('records an error when the snapshot request fails', async () => {
    const state = createRepoState({
      api: {
        async snapshot() {
          throw new Error('boom')
        },
        async diff() {
          throw new Error('not used')
        },
        async mutate() {
          throw new Error('not used')
        },
        async commit() {
          throw new Error('not used')
        },
      },
    })
    await state.refreshSnapshot()
    expect(state.error).toMatch(/boom/)
    expect(state.snapshot).toBeNull()
  })

  it('reruns a queued refresh when calls overlap', async () => {
    let calls = 0
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const state = createRepoState({
      api: {
        async snapshot() {
          calls += 1
          if (calls === 1) await gate
          return snapshot({ generation: calls + 1, unstaged: [change('unstaged', `f${calls}.txt`)] })
        },
        async diff() {
          throw new Error('not used')
        },
        async mutate() {
          throw new Error('not used')
        },
        async commit() {
          throw new Error('not used')
        },
      },
    })

    void state.refreshSnapshot()
    void state.refreshSnapshot()
    release()

    await vi.waitFor(() => expect(state.generation).toBe(3), { timeout: 1000 })
    expect(state.snapshot?.unstaged[0]?.path).toBe('f2.txt')
  })

  it('mutates and refreshes the snapshot afterwards', async () => {
    const mutate = vi.fn(async () => {})
    const api: ApiClient = {
      async snapshot() {
        return snapshot({ generation: 2, unstaged: [change('unstaged', 'x.txt')] })
      },
      async diff() {
        throw new Error('not used')
      },
      mutate,
      async commit() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })

    await state.mutate({ op: 'stage', paths: ['x.txt'] })

    expect(mutate).toHaveBeenCalledWith({ op: 'stage', paths: ['x.txt'] })
    await vi.waitFor(() => expect(state.snapshot).not.toBeNull())
    expect(state.busy).toBe(false)
  })

  it('surfaces a failed mutation and rethrows', async () => {
    const state = createRepoState({
      api: {
        async snapshot() {
          return snapshot({ generation: 2 })
        },
        async diff() {
          throw new Error('not used')
        },
        async mutate() {
          throw new Error('patch does not apply')
        },
        async commit() {
          throw new Error('not used')
        },
      },
    })

    await expect(state.mutate({ op: 'patch', patch: 'stale' })).rejects.toThrow('patch does not apply')
    expect(state.mutationError).toMatch(/patch does not apply/)
    expect(state.busy).toBe(false)
  })

  it('commits staged changes and refreshes the snapshot', async () => {
    const commit = vi.fn(async () => ({ ok: true }))
    const api: ApiClient = {
      async snapshot() {
        return snapshot({ generation: 2, staged: [change('staged', 'x.txt')] })
      },
      async diff() {
        throw new Error('not used')
      },
      async mutate() {
        throw new Error('not used')
      },
      commit,
    }
    const state = createRepoState({ api })

    await state.commit('feature work')

    expect(commit).toHaveBeenCalledWith({ message: 'feature work', amend: false })
    expect(state.mutationError).toBeNull()
    await vi.waitFor(() => expect(state.snapshot).not.toBeNull())
    expect(state.busy).toBe(false)
  })

  it('surfaces a rejected hook without clearing mutationError', async () => {
    const state = createRepoState({
      api: {
        async snapshot() {
          return snapshot({ generation: 2 })
        },
        async diff() {
          throw new Error('not used')
        },
        async mutate() {
          throw new Error('not used')
        },
        async commit() {
          return { ok: false, exitCode: 1, stderr: 'policy rejects this commit' }
        },
      },
    })

    await expect(state.commit('subject', true)).rejects.toThrow(/policy rejects this commit/)
    expect(state.mutationError).toMatch(/policy rejects this commit/)
    expect(state.busy).toBe(false)
  })
})

describe('coalesce', () => {
  it('collapses a burst into a single refresh after the quiet period', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const schedule = coalesce(refresh, 50)

    schedule()
    schedule()
    schedule()

    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(49)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('allows a later burst to trigger another refresh', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const schedule = coalesce(refresh, 50)

    schedule()
    vi.advanceTimersByTime(51)
    expect(refresh).toHaveBeenCalledTimes(1)

    schedule()
    vi.advanceTimersByTime(51)
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
