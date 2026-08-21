import type { RepoSnapshot } from '../../src/lib/types'

/**
 * Representative snapshot matching the backend JSON contract, exercising the
 * grouping cases the UI relies on: staged-only, unstaged-only, a file present
 * in both scopes, a rename, a conflict, and branch tracking counts.
 */
export const snapshotFixture: RepoSnapshot = {
  root: '/tmp/example-repo',
  headOid: 'abc123def456',
  headBranch: 'main',
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  operation: 'none',
  staged: [
    { path: 'staged-only.txt', kind: 'added', scope: 'staged', staged: true, conflicted: false },
    {
      path: 'src/both.txt',
      oldPath: 'src/old.txt',
      kind: 'renamed',
      scope: 'staged',
      staged: true,
      conflicted: false,
    },
    { path: 'both.txt', kind: 'modified', scope: 'staged', staged: true, conflicted: false },
  ],
  unstaged: [
    { path: 'tracked.txt', kind: 'modified', scope: 'unstaged', staged: false, conflicted: false },
    { path: 'both.txt', kind: 'modified', scope: 'unstaged', staged: false, conflicted: false },
    {
      path: 'new file.txt',
      kind: 'untracked',
      scope: 'unstaged',
      staged: false,
      conflicted: false,
    },
    {
      path: 'conflicted.txt',
      kind: 'conflicted',
      scope: 'unstaged',
      staged: false,
      conflicted: true,
    },
  ],
  generation: 7,
}
