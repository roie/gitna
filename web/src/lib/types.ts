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

export interface CommitStats {
  files: number
  additions: number
  deletions: number
  binaryFiles: number
}

export interface CommitFiles {
  files: CommitFile[]
  stats?: CommitStats
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

export interface ImageContent {
  mime: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
  data: string
  size: number
}

export interface FileVersion {
  path: string
  language?: string
  content: string
  image?: ImageContent
}

export interface FileDiff {
  before: FileVersion
  after: FileVersion
  binary: boolean
  tooLarge: boolean
  patch?: string
  patchId?: string
}

export interface ReviewIdentity {
  scope: DiffScope
  commit?: string
  from?: string
  to?: string
}

export interface ReviewSupplement {
  path: string
  kind: ChangeKind
  diff: FileDiff
}

export interface ReviewResponse {
  generation: number
  identity: ReviewIdentity
  patch: string
  supplements: ReviewSupplement[]
}

export interface RepositoryFiles {
  generation: number
  paths: string[]
  ignoredPaths?: string[]
  truncated: boolean
  nextCursor?: string
}

export interface WorktreeFile {
  path: string
  content: string
  hash: string
}

export interface RepoSnapshot {
  appVersion: string
  root: string
  headOid?: string
  headBranch?: string
  upstream?: string
  ahead: number
  behind: number
  operation: string
  staged: FileChange[]
  unstaged: FileChange[]
  conflicts?: ConflictEntry[]
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

export interface ConflictEntry {
  path: string
  baseOid: string
  oursOid: string
  theirsOid: string
  mode?: string
  canResolveBoth?: boolean
}
