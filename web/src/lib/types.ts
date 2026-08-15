export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'ignored'
  | 'conflicted'

export type ChangeScope = 'unstaged' | 'staged'

export interface FileChange {
  path: string
  oldPath?: string
  kind: ChangeKind
  scope: ChangeScope
  staged: boolean
  conflicted: boolean
}

export interface RepoSnapshot {
  root: string
  headOid?: string
  headBranch?: string
  upstream?: string
  ahead: number
  behind: number
  operation: string
  staged: FileChange[]
  unstaged: FileChange[]
  generation: number
}
