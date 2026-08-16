import { describe, expect, it } from 'vitest'
import { createRepoState, reconcileSelection } from '../src/lib/repo-state.svelte'
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
      },
    })
    await state.refreshSnapshot()
    expect(state.error).toMatch(/boom/)
    expect(state.snapshot).toBeNull()
  })
})
