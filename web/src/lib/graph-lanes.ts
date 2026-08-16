import type { GraphCommit } from './types'

export interface GraphLane {
  /** Column the lane occupies at this row. */
  column: number
  /** The commit this lane waits for; it arrives at the row whose commit oid matches. */
  next: string
}

export interface GraphRow {
  commit: GraphCommit
  /** Column the commit node is drawn on. */
  column: number
  /** Number of columns the row needs to draw its incoming and outgoing lanes. */
  totalColumns: number
  /** Lanes entering this row from above, one per active column. */
  lanes: GraphLane[]
  /** Columns of lines that continue below the node (first parent and the
   * lanes claimed for the remaining parents). */
  outgoing: number[]
}

/**
 * Assigns a stable lane column to each commit in topological order (newest
 * first) so the graph can be drawn as a set of vertical lanes with nodes and
 * curves. Mirrors what `git log --graph` produces:
 *
 * - a commit sits on the first lane that was waiting for it; otherwise it
 *   claims a fresh column;
 * - the first parent continues the commit's column;
 * - every other parent claims a new column (or reuses a freed one);
 * - lanes that were waiting for a commit but did not become its column merge
 *   into the node (they "bend in").
 */
export function computeGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const freed: number[] = []

  function claimColumn(): number {
    if (freed.length > 0) {
      let min = 0
      for (let i = 1; i < freed.length; i++) {
        if (freed[i]! < freed[min]!) min = i
      }
      const [col] = freed.splice(min, 1)
      return col!
    }
    return lanes.length
  }

  const rows: GraphRow[] = []
  for (const commit of commits) {
    let nodeCol = -1
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.oid) {
        nodeCol = i
        break
      }
    }
    if (nodeCol === -1) nodeCol = claimColumn()

    const incoming: GraphLane[] = []
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null) incoming.push({ column: i, next: lanes[i]! })
    }

    const [first, ...rest] = commit.parents

    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.oid && i !== nodeCol) {
        lanes[i] = null
        freed.push(i)
      }
    }
    const outgoing: number[] = []
    if (first) {
      lanes[nodeCol] = first
      outgoing.push(nodeCol)
    } else {
      lanes[nodeCol] = null
      freed.push(nodeCol)
    }
    for (const parent of rest) {
      const col = claimColumn()
      outgoing.push(col)
      lanes[col] = parent
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    let maxIncoming = -1
    for (const lane of incoming) maxIncoming = Math.max(maxIncoming, lane.column)
    rows.push({
      commit,
      column: nodeCol,
      totalColumns: Math.max(nodeCol + 1, maxIncoming + 1, lanes.length),
      lanes: incoming,
      outgoing,
    })
  }
  return rows
}
