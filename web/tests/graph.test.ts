import { describe, expect, it } from 'vitest'
import { computeGraph } from '../src/lib/graph-lanes'
import type { GraphCommit, GraphRow } from '../src/lib/types'
import type { GraphLane } from '../src/lib/graph-lanes'

function commit(oid: string, parents: string[], subject = oid): GraphCommit {
  return {
    oid,
    parents,
    subject,
    authorName: 'T',
    authorTime: '2026-01-01T00:00:00Z',
    refs: [],
  }
}

function render(rows: GraphRow[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const w = row.totalColumns

    let above = ''
    for (let j = 0; j < w; j++) {
      const lane = row.lanes.find((l: GraphLane) => l.column === j)
      if (!lane) {
        above += ' '
      } else if (lane.next === row.commit.oid) {
        above += lane.column === row.column ? '|' : lane.column > row.column ? '/' : '\\'
      } else {
        above += '|'
      }
    }

    let node = ''
    for (let j = 0; j < w; j++) {
      if (j === row.column) {
        node += '*'
      } else {
        const lane = row.lanes.find((l: GraphLane) => l.column === j)
        node += lane && lane.next !== row.commit.oid ? '|' : ' '
      }
    }
    lines.push(above, node)
  }
  return lines
}

describe('computeGraph', () => {
  it('linear history keeps a single column', () => {
    const rows = computeGraph([commit('c', ['b']), commit('b', ['a']), commit('a', [])])
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0])
    expect(rows.map((r) => r.totalColumns)).toEqual([1, 1, 1])
    expect(render(rows)).toEqual([' ', '*', '|', '*', '|', '*'])
  })

  it('two branches merge into one node with a curve', () => {
    const rows = computeGraph([
      commit('M', ['A', 'B']),
      commit('A', ['C']),
      commit('B', ['C']),
      commit('C', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 0])
    expect(render(rows)).toEqual(['  ', '* ', '||', '*|', '||', '|*', '|/', '* '])
  })

  it('two branches converge through a shared parent', () => {
    const rows = computeGraph([
      commit('M', ['A', 'B']),
      commit('A', ['C']),
      commit('B', ['C']),
      commit('C', ['D']),
      commit('D', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 0, 0])
  })

  it('octopus merge fans out lanes for every parent', () => {
    const rows = computeGraph([
      commit('M', ['A', 'B', 'C']),
      commit('A', ['R']),
      commit('B', ['R']),
      commit('C', ['R']),
      commit('R', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 2, 0])
    expect(rows[1]!.totalColumns).toBeGreaterThanOrEqual(3)
  })

  it('a merge whose second parent branch has two commits bends at the merge', () => {
    //          M
    //         /|
    //        | B
    //        | |
    //        A Bp
    //         \|
    //          C
    const rows = computeGraph([
      commit('M', ['A', 'B']),
      commit('A', ['C']),
      commit('B', ['Bp']),
      commit('Bp', ['C']),
      commit('C', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 1, 0])
  })

  it('two siblings of the same parent bend into it', () => {
    //     M
    //     |
    //     N  (sibling of M, both children of R)
    //     |\
    //     | R
    const rows = computeGraph([
      commit('M', ['R']),
      commit('N', ['R']),
      commit('R', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0])
  })

  it('stable columns across a freed lane', () => {
    // M (parents A,B); B root; A merges C which then fans into R
    const rows = computeGraph([
      commit('M', ['A', 'B']),
      commit('A', ['C']),
      commit('B', []),
      commit('C', ['R']),
      commit('R', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 0, 0])
  })

  it('reuses a freed column for a later branch', () => {
    // Root-first graph: R splits into X and Y, X merges Y? keep simple:
    const rows = computeGraph([
      commit('X', ['R']),
      commit('Y', ['R']),
      commit('R', ['S']),
      commit('S', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 0])
    expect(rows[2]!.totalColumns).toBeLessThanOrEqual(2)
  })

  it('empty history yields no rows', () => {
    expect(computeGraph([])).toEqual([])
  })

  it('tolerates sibling parents emitted in any order', () => {
    // Both A and B are parents of M and siblings of each other, so either may
    // be emitted first in topo order; lanes must still converge at R.
    const rows = computeGraph([
      commit('M', ['A', 'B']),
      commit('B', ['R']),
      commit('A', ['R']),
      commit('R', []),
    ])
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 0])
  })
})
