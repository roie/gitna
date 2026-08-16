export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'ignored'
  | 'conflicted'

export type RefKind = 'head' | 'local-branch' | 'remote-branch' | 'tag'

export interface CommitRef {
  name: string
  kind: RefKind
}

export interface GraphCommit {
  oid: string
  parents: string[]
  subject: string
  authorName: string
  authorTime: string
  refs: CommitRef[]
}

export interface GraphPage {
  commits: GraphCommit[]
  hasMore: boolean
}

export interface CommitFile {
  path: string
  oldPath?: string
  kind: ChangeKind
}

export interface CommitFiles {
  files: CommitFile[]
}

export type ChangeScope = 'unstaged' | 'staged'

export type DiffScope = ChangeScope | 'commit' | 'compare'

export interface FileChange {
  path: string
  oldPath?: string
  kind: ChangeKind
  scope: ChangeScope
  staged: boolean
  conflicted: boolean
}

export interface FileVersion {
  path: string
  language?: string
  content: string
}

export interface FileDiff {
  before: FileVersion
  after: FileVersion
  binary: boolean
  tooLarge: boolean
  patch?: string
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

export interface Branch {
  name: string
  oid: string
  current: boolean
  remote: boolean
  upstream?: string
  ahead: number
  behind: number
}

export interface StashEntry {
  ref: string
  oid: string
  message: string
  branch: string
}

export interface Tag {
  name: string
  oid: string
  annotated: boolean
}
