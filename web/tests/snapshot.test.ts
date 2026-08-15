import { describe, expect, it } from 'vitest'
import type { RepoSnapshot } from '../src/lib/types'
import { snapshotFixture } from './fixtures/snapshot'

describe('repo snapshot', () => {
  it('deserializes a representative snapshot from the JSON contract', () => {
    const snap = JSON.parse(JSON.stringify(snapshotFixture)) as RepoSnapshot
    expect(snap.headBranch).toBe('main')
    expect(snap.upstream).toBe('origin/main')
    expect(snap.ahead).toBe(2)
    expect(snap.behind).toBe(1)
    expect(snap.generation).toBe(7)
  })

  it('keeps staged and unstaged changes grouped by scope', () => {
    const snap = snapshotFixture
    expect(snap.staged.every((c) => c.scope === 'staged' && c.staged)).toBe(true)
    expect(snap.unstaged.every((c) => c.scope === 'unstaged' && !c.staged)).toBe(true)
  })

  it('contains the same file in both scopes when both sides changed', () => {
    const snap = snapshotFixture
    const staged = snap.staged.filter((c) => c.path === 'both.txt')
    const unstaged = snap.unstaged.filter((c) => c.path === 'both.txt')
    expect(staged).toHaveLength(1)
    expect(staged[0].kind).toBe('modified')
    expect(unstaged).toHaveLength(1)
    expect(unstaged[0].scope).toBe('unstaged')
  })

  it('surfaces rename and conflict metadata', () => {
    const snap = snapshotFixture
    const renamed = snap.staged.find((c) => c.path === 'src/both.txt')
    expect(renamed?.kind).toBe('renamed')
    expect(renamed?.oldPath).toBe('src/old.txt')

    const conflicted = snap.unstaged.find((c) => c.path === 'conflicted.txt')
    expect(conflicted?.conflicted).toBe(true)
    expect(conflicted?.kind).toBe('conflicted')
  })
})
