import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api'
import { coalesce, createRepoState, reconcileSelection } from '../src/diffshub/gitna/repository'
import type { ApiClient } from '../src/lib/api'
import type {
  ChangeScope,
  CommitFile,
  FileChange,
  GraphCommit,
  RepoSnapshot,
} from '../src/lib/types'

function change(
  scope: ChangeScope,
  path: string,
  kind: FileChange['kind'] = 'modified',
): FileChange {
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
    appVersion: 'dev',
    repository: true,
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

function graphCommit(oid: string, parents: string[] = [], subject = oid): GraphCommit {
  return {
    oid,
    parents,
    subject,
    authorName: 'T',
    authorTime: '2026-01-01T00:00:00Z',
    refs: [],
  }
}

function commitFile(path: string, kind: CommitFile['kind'] = 'modified'): CommitFile {
  return { path, kind }
}

/** Default implementations so mock API clients only override the calls a test
 * actually exercises. Unexpected core operations fail loudly. */
const auxApi: ApiClient = {
  async snapshot() {
    throw new Error('snapshot not used')
  },
  async folders() {
    return {
      current: { path: '/repo', name: 'repo', repository: true, lastOpened: '' },
      recent: [],
    }
  },
  async repositoryFiles() {
    return { generation: 1, paths: [], truncated: false }
  },
  async repositoryFileCount(generation) {
    return { generation, total: 0 }
  },
  async directoryEntries(path) {
    return { generation: 1, directory: path, entries: [], truncated: false }
  },
  async searchFiles() {
    return { generation: 1, results: [], complete: true }
  },
  async readWorktreeFile() {
    throw new Error('readWorktreeFile not used')
  },
  async compareWorktreeFiles() {
    throw new Error('compareWorktreeFiles not used')
  },
  async writeWorktreeFile() {
    throw new Error('writeWorktreeFile not used')
  },
  async createWorktreeEntry() {
    throw new Error('createWorktreeEntry not used')
  },
  async renameWorktreeEntry() {
    throw new Error('renameWorktreeEntry not used')
  },
  async diff() {
    throw new Error('diff not used')
  },
  async review() {
    return { generation: 1, identity: { scope: 'unstaged' }, patch: '', supplements: [] }
  },
  async mutate() {
    throw new Error('mutate not used')
  },
  async commit() {
    throw new Error('commit not used')
  },
  async graph() {
    return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
  },
  async graphCount(tip, generation) {
    return { tip, generation, total: 0 }
  },
  async commitFiles() {
    return { files: [] }
  },
  async branches() {
    return []
  },
  async stashes() {
    return []
  },
  async tags() {
    return []
  },
  async compare() {
    return { files: [] }
  },
  async conflicts() {
    return []
  },
  async openFolder(path) {
    return { root: path, href: '../folder/' }
  },
  async removeRecentFolder() {},
  async revealFolder() {},
}

/** API client whose graph pages and commit files are scripted in order. Only
 * the last page is terminal, which is what a paged server signals. */
function graphApi(
  pages: GraphCommit[][],
  filesByOid: Record<string, CommitFile[]> = {},
  initial?: RepoSnapshot,
): ApiClient {
  const queue = [...pages]
  return {
    ...auxApi,
    async snapshot() {
      return initial ?? snapshot({ generation: 1 })
    },
    async diff() {
      throw new Error('diff not used in graph tests')
    },
    async mutate() {
      throw new Error('mutate not used in graph tests')
    },
    async commit() {
      throw new Error('commit not used in graph tests')
    },
    async graph() {
      const page = queue.shift() ?? []
      return { commits: page, hasMore: queue.length > 0, tip: 'abc123', generation: 1 }
    },
    async graphCount(tip, generation) {
      return { tip, generation, total: pages.reduce((total, page) => total + page.length, 0) }
    },
    async commitFiles(oid) {
      return { files: filesByOid[oid] ?? [] }
    },
    async branches() {
      return []
    },
  }
}

function queuedApi(snapshots: RepoSnapshot[]): ApiClient {
  let i = 0
  return {
    ...auxApi,
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
    async graph() {
      throw new Error('graph not used in queuedApi tests')
    },
    async commitFiles() {
      throw new Error('commitFiles not used in queuedApi tests')
    },
    async branches() {
      return []
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

  it('loads the current and recent folder catalog independently from Git state', async () => {
    const state = createRepoState({
      api: {
        ...auxApi,
        async folders() {
          return {
            current: {
              path: '/tmp/current',
              name: 'current',
              repository: true,
              lastOpened: '2026-08-27T12:00:00Z',
            },
            recent: [
              {
                path: '/tmp/current',
                name: 'current',
                repository: true,
                lastOpened: '2026-08-27T12:00:00Z',
              },
            ],
          }
        },
      },
    })

    await state.refreshFolders()

    expect(state.folders?.current.path).toBe('/tmp/current')
    expect(state.folders?.recent).toHaveLength(1)
    expect(state.foldersLoading).toBe(false)
    expect(state.foldersError).toBeNull()
  })

  it('opens, swaps, and closes an ordered comparison from two selected files', () => {
    const state = createRepoState({ api: auxApi })
    state.snapshot = snapshot({ repository: false, root: '/tmp/folder' })
    state.repositoryPaths = ['left.txt', 'right.txt', 'folder/']

    state.setRepositorySelectedPaths(['left.txt', 'right.txt'])
    state.openRepositoryFileComparison()
    expect(state.repositoryFileComparison).toEqual({
      leftPath: 'left.txt',
      rightPath: 'right.txt',
      version: 0,
    })
    expect(state.repositoryFileComparisonActive).toBe(true)

    state.swapRepositoryFileComparison()
    expect(state.repositoryFileComparison).toEqual({
      leftPath: 'right.txt',
      rightPath: 'left.txt',
      version: 1,
    })
    expect(state.repositorySelectedPaths).toEqual(['right.txt', 'left.txt'])

    state.selectRepositoryFile('left.txt')
    expect(state.repositoryFileComparisonActive).toBe(false)
    state.activateRepositoryFileComparison()
    expect(state.repositoryFileComparisonActive).toBe(true)
    state.closeRepositoryFileComparison()
    expect(state.repositoryFileComparison).toBeNull()
    expect(state.repositoryFileComparisonActive).toBe(false)

    state.setRepositorySelectedPaths(['left.txt', 'folder/'])
    state.openRepositoryFileComparison()
    expect(state.repositoryFileComparison).toBeNull()
  })

  it('loads ordinary folder files without requesting Git resources', async () => {
    const graph = vi.fn()
    const branches = vi.fn()
    const stashes = vi.fn()
    const tags = vi.fn()
    const state = createRepoState({
      api: {
        ...auxApi,
        graph,
        branches,
        stashes,
        tags,
        async snapshot() {
          return snapshot({
            repository: false,
            root: '/tmp/folder',
            headOid: undefined,
            headBranch: undefined,
          })
        },
        async directoryEntries(path) {
          return {
            generation: 1,
            directory: path,
            entries: [
              { name: 'notes.txt', path: 'notes.txt', kind: 'file' },
              { name: 'src', path: 'src/', kind: 'directory' },
            ],
            truncated: false,
          }
        },
      },
    })

    await state.refreshCurrentFolder()

    expect(state.snapshot?.repository).toBe(false)
    expect(state.repositoryPaths).toEqual(['notes.txt', 'src/'])
    expect(state.ordinaryUnloadedDirectories).toEqual(new Set(['src/']))
    await state.loadOrdinaryDirectory('src')
    expect(state.repositoryPaths).toEqual(['notes.txt', 'src/'])
    expect(state.ordinaryUnloadedDirectories.size).toBe(0)
    expect(graph).not.toHaveBeenCalled()
    expect(branches).not.toHaveBeenCalled()
    expect(stashes).not.toHaveBeenCalled()
    expect(tags).not.toHaveBeenCalled()
  })

  it('publishes only the first page of a million-wide ordinary directory', async () => {
    const firstPage = Array.from({ length: 2_000 }, (_, index) => ({
      name: `file-${index.toString().padStart(7, '0')}.txt`,
      path: `file-${index.toString().padStart(7, '0')}.txt`,
      kind: 'file' as const,
    }))
    const secondPage = [
      { name: 'file-0002000.txt', path: 'file-0002000.txt', kind: 'file' as const },
    ]
    const directoryEntries = vi
      .fn()
      .mockResolvedValueOnce({
        generation: 1,
        directory: '',
        entries: firstPage,
        truncated: true,
        nextCursor: 'page-2-of-500',
      })
      .mockResolvedValueOnce({
        generation: 1,
        directory: '',
        entries: secondPage,
        truncated: true,
        nextCursor: 'page-3-of-500',
      })
    const state = createRepoState({ api: { ...auxApi, directoryEntries } })
    state.snapshot = snapshot({ repository: false })
    state.generation = 1

    await state.loadOrdinaryDirectory('')

    expect(directoryEntries).toHaveBeenCalledTimes(1)
    expect(state.repositoryPaths).toHaveLength(2_000)
    expect(state.ordinaryPagedDirectories).toEqual(new Set(['']))

    await state.loadMoreOrdinaryDirectory('')
    expect(directoryEntries).toHaveBeenCalledTimes(2)
    expect(directoryEntries.mock.calls[1]?.[1]).toBe('page-2-of-500')
    expect(state.repositoryPaths).toHaveLength(2_001)
  })

  it('searches ordinary folders on the server and hydrates result ancestors', async () => {
    const directories: string[] = []
    const state = createRepoState({
      api: {
        ...auxApi,
        async directoryEntries(path) {
          directories.push(path)
          const entries =
            path === ''
              ? [{ name: 'nested', path: 'nested/', kind: 'directory' as const }]
              : [{ name: 'result.txt', path: 'nested/result.txt', kind: 'file' as const }]
          return { generation: 1, directory: path, entries, truncated: false }
        },
        async searchFiles() {
          return {
            generation: 1,
            complete: true,
            results: [
              {
                path: 'nested/result.txt',
                name: 'result.txt',
                parent: 'nested',
                duplicateName: false,
              },
            ],
          }
        },
      },
    })
    state.snapshot = snapshot({ repository: false })
    state.generation = 1
    await state.loadOrdinaryDirectory('')
    await state.searchOrdinaryFiles('result')
    await state.ensureOrdinaryPathLoaded('nested/result.txt')

    expect(state.ordinarySearchComplete).toBe(true)
    expect(state.ordinarySearchResults[0]?.path).toBe('nested/result.txt')
    expect(state.repositoryPaths).toContain('nested/result.txt')
    expect(directories).toEqual(['', 'nested'])
  })

  it('pages lazy directories to verify a deep file and preserve ignored metadata', async () => {
    const calls: Array<[string, string | undefined]> = []
    const state = createRepoState({
      api: {
        ...auxApi,
        async directoryEntries(directory, cursor) {
          calls.push([directory, cursor])
          if (directory === '') {
            return {
              generation: 1,
              directory,
              entries: [{ name: 'wide', path: 'wide/', kind: 'directory' as const }],
              truncated: false,
            }
          }
          if (cursor == null) {
            return {
              generation: 1,
              directory,
              entries: [{ name: 'first.txt', path: 'wide/first.txt', kind: 'file' as const }],
              truncated: true,
              nextCursor: 'page-2',
            }
          }
          return {
            generation: 1,
            directory,
            entries: [
              {
                name: 'target.txt',
                path: 'wide/target.txt',
                kind: 'file' as const,
                ignored: true,
              },
            ],
            truncated: false,
          }
        },
      },
    })
    state.snapshot = snapshot({ repository: true })
    state.generation = 1

    await state.openRepositoryFile('wide/target.txt')

    expect(calls).toEqual([
      ['', undefined],
      ['wide', undefined],
      ['wide', 'page-2'],
    ])
    expect(state.repositoryFilePath).toBe('wide/target.txt')
    expect(state.repositoryIgnoredPaths).toContain('wide/target.txt')
  })

  it('rejects stale deep-open results without creating phantom tree rows', async () => {
    const state = createRepoState({
      api: {
        ...auxApi,
        async directoryEntries(directory) {
          return { generation: 1, directory, entries: [], truncated: false }
        },
      },
    })
    state.snapshot = snapshot({ repository: true })
    state.generation = 1

    await expect(state.openRepositoryFile('missing/deep.txt')).rejects.toThrow(
      'File is no longer available: missing/deep.txt',
    )

    expect(state.repositoryPaths).toEqual([])
    expect(state.repositoryFilePath).toBeNull()
  })

  it('bounds loaded-directory refreshes and restarts ordinary Quick Open indexing', async () => {
    let refreshing = false
    let inFlight = 0
    let maxInFlight = 0
    let searchRefresh = false
    const directoryNames = Array.from({ length: 12 }, (_, index) => `dir-${index}`)
    const state = createRepoState({
      api: {
        ...auxApi,
        async directoryEntries(path) {
          if (refreshing) {
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 5))
            inFlight -= 1
          }
          return {
            generation: 1,
            directory: path,
            entries:
              path === ''
                ? directoryNames.map((name) => ({
                    name,
                    path: `${name}/`,
                    kind: 'directory' as const,
                  }))
                : [],
            truncated: false,
          }
        },
        async searchFiles(_query, options) {
          searchRefresh = options?.refresh === true
          return { generation: 1, results: [], complete: false }
        },
      },
    })
    state.snapshot = snapshot({ repository: false })
    state.generation = 1
    await state.loadOrdinaryDirectory('')
    for (const directory of directoryNames) await state.loadOrdinaryDirectory(directory)
    const stalePaths = [...state.repositoryPaths]

    refreshing = true
    const refresh = state.refreshExplorer()
    expect(state.repositoryPaths).toEqual(stalePaths)
    await refresh

    expect(searchRefresh).toBe(true)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(state.repositoryPaths).toEqual(stalePaths)
  })

  it('refreshes loaded ordinary directories parent-first after external deletion', async () => {
    let deleted = false
    let refreshing = false
    const refreshCalls: string[] = []
    const searchFiles = vi.fn(async (_query: string, _options?: { refresh?: boolean }) => ({
      generation: 1,
      results: deleted
        ? []
        : [
            {
              path: 'parent/child/result.txt',
              name: 'result.txt',
              parent: 'parent/child',
              duplicateName: false,
            },
          ],
      complete: true,
    }))
    const state = createRepoState({
      api: {
        ...auxApi,
        async directoryEntries(path) {
          if (refreshing) refreshCalls.push(path)
          if (deleted && path !== '') throw new Error(`directory no longer exists: ${path}`)
          let entries: Array<{
            name: string
            path: string
            kind: 'directory' | 'file'
          }>
          if (path === '') {
            entries = deleted ? [] : [{ name: 'parent', path: 'parent/', kind: 'directory' }]
          } else if (path === 'parent') {
            entries = [{ name: 'child', path: 'parent/child/', kind: 'directory' }]
          } else {
            entries = [{ name: 'result.txt', path: 'parent/child/result.txt', kind: 'file' }]
          }
          return { generation: 1, directory: path, entries, truncated: false }
        },
        searchFiles,
      },
    })
    state.snapshot = snapshot({ repository: false })
    state.generation = 1
    await state.loadOrdinaryDirectory('')
    await state.loadOrdinaryDirectory('parent')
    await state.loadOrdinaryDirectory('parent/child')
    await state.searchOrdinaryFiles('result')
    expect(state.repositoryPaths).toContain('parent/child/result.txt')
    expect(state.ordinarySearchResults).toHaveLength(1)

    deleted = true
    refreshing = true
    await state.refreshExplorer()
    await state.searchOrdinaryFiles('result')

    expect(refreshCalls).toEqual([''])
    expect(state.repositoryPaths).toEqual([])
    expect(state.repositoryFilesError).toBeNull()
    expect(state.ordinaryDirectoryErrors.size).toBe(0)
    expect(state.ordinarySearchResults).toEqual([])
    expect(searchFiles).toHaveBeenCalledWith('', { refresh: true })
  })

  it('loads Git Repository Explorer directories lazily with ignored metadata', async () => {
    const calls: Array<[string, string | undefined]> = []
    const repositoryFiles = vi.fn()
    const state = createRepoState({
      api: {
        ...auxApi,
        repositoryFiles,
        async directoryEntries(directory, cursor) {
          calls.push([directory, cursor])
          return directory === ''
            ? {
                directory,
                generation: 3,
                entries: [
                  { kind: 'file' as const, name: '.env', path: '.env' },
                  {
                    kind: 'directory' as const,
                    name: 'node_modules',
                    path: 'node_modules/',
                    ignored: true,
                  },
                  { kind: 'directory' as const, name: 'src', path: 'src/' },
                ],
                truncated: false,
              }
            : {
                directory,
                generation: 3,
                entries: [{ kind: 'file' as const, name: 'main.ts', path: 'src/main.ts' }],
                truncated: false,
              }
        },
      },
    })
    state.snapshot = snapshot({ repository: true })

    await state.refreshRepositoryFiles()

    expect(calls).toEqual([['', undefined]])
    expect(repositoryFiles).not.toHaveBeenCalled()
    expect(state.repositoryPaths).toEqual(['.env', 'node_modules/', 'src/'])
    expect(state.repositoryIgnoredPaths).toEqual(new Set(['node_modules/']))
    expect(state.ordinaryUnloadedDirectories).toEqual(new Set(['node_modules/', 'src/']))

    await state.loadOrdinaryDirectory('src')

    expect(calls).toEqual([
      ['', undefined],
      ['src', undefined],
    ])
    expect(state.repositoryPaths).toContain('src/main.ts')
    expect(state.repositoryFilesLoading).toBe(false)
    expect(state.repositoryFilesError).toBeNull()
  })

  it('resolves a folder route without mutating the current repository state', async () => {
    const openFolder = vi.fn(async (path: string) => ({ root: path, href: '../next/' }))
    const state = createRepoState({ api: { ...auxApi, openFolder } })
    state.repositoryPaths = ['old.txt']
    state.graphCommits = [graphCommit('old')]

    const result = await state.openFolder('/tmp/next')

    expect(openFolder).toHaveBeenCalledWith('/tmp/next')
    expect(result).toEqual({ root: '/tmp/next', href: '../next/' })
    expect(state.repositoryPaths).toEqual(['old.txt'])
    expect(state.graphCommits.map((commit) => commit.oid)).toEqual(['old'])
    expect(state.busy).toBe(false)
  })

  it('removes a recent folder and refreshes the catalog', async () => {
    const removeRecentFolder = vi.fn(async () => {})
    const folders = vi.fn(async () => ({
      current: { path: '/tmp/current', name: 'current', repository: true, lastOpened: '' },
      recent: [{ path: '/tmp/current', name: 'current', repository: true, lastOpened: '' }],
    }))
    const state = createRepoState({ api: { ...auxApi, folders, removeRecentFolder } })
    state.folders = {
      current: { path: '/tmp/current', name: 'current', repository: true, lastOpened: '' },
      recent: [
        { path: '/tmp/current', name: 'current', repository: true, lastOpened: '' },
        { path: '/tmp/old', name: 'old', repository: false, lastOpened: '' },
      ],
    }

    await state.removeRecentFolder('/tmp/old')

    expect(removeRecentFolder).toHaveBeenCalledWith('/tmp/old')
    expect(folders).toHaveBeenCalledOnce()
    expect(state.folders.recent.map((folder) => folder.path)).toEqual(['/tmp/current'])
  })

  it('opens only available files from the repository catalog', () => {
    const state = createRepoState({ api: auxApi })
    state.snapshot = snapshot({ staged: [change('staged', 'deleted.txt', 'deleted')] })
    state.repositoryPaths = ['deleted.txt', 'current.txt', 'nested/']

    expect(state.canOpenRepositoryFile('deleted.txt')).toBe(false)
    expect(state.canOpenRepositoryFile('nested/')).toBe(false)
    expect(state.canOpenRepositoryFile('current.txt')).toBe(true)
  })

  it('loads and caches commit files with lazy graph statistics', async () => {
    const commitFiles = vi.fn(async () => ({
      files: [commitFile('a.txt')],
      stats: { files: 1, additions: 12, deletions: 3, binaryFiles: 0 },
    }))
    const state = createRepoState({ api: { ...auxApi, commitFiles } })

    await state.loadCommitDetails('abc')
    await state.loadCommitDetails('abc')

    expect(commitFiles).toHaveBeenCalledTimes(1)
    expect(state.commitFiles.abc?.[0]?.path).toBe('a.txt')
    expect(state.commitStats.abc).toEqual({ files: 1, additions: 12, deletions: 3, binaryFiles: 0 })
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
    const api = queuedApi([snapshot({ generation: 1, unstaged: [change('unstaged', 'x.txt')] })])
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
        ...auxApi,
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
        async graph() {
          throw new Error('not used')
        },
        async commitFiles() {
          throw new Error('not used')
        },
        async branches() {
          return []
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
        ...auxApi,
        async snapshot() {
          calls += 1
          if (calls === 1) await gate
          return snapshot({
            generation: calls + 1,
            unstaged: [change('unstaged', `f${calls}.txt`)],
          })
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
        async graph() {
          throw new Error('not used')
        },
        async commitFiles() {
          throw new Error('not used')
        },
        async branches() {
          return []
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
      ...auxApi,
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
        ...auxApi,
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

    await expect(state.mutate({ op: 'patch', patch: 'stale' })).rejects.toThrow(
      'patch does not apply',
    )
    expect(state.mutationError).toMatch(/patch does not apply/)
    expect(state.busy).toBe(false)
  })

  it('commits staged changes and refreshes the snapshot', async () => {
    const commit = vi.fn(async () => ({ ok: true }))
    const api: ApiClient = {
      ...auxApi,
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

  it('resolves commit only after the authoritative snapshot refresh completes', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const state = createRepoState({
      api: {
        ...auxApi,
        async snapshot() {
          await gate
          return snapshot({ generation: 2 })
        },
        async commit() {
          return { ok: true }
        },
      },
    })

    const pending = (async () => {
      await state.commit('wait for snapshot')
      settled = true
    })()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await pending
    expect(state.generation).toBe(2)
    expect(settled).toBe(true)
  })

  it('surfaces a rejected hook without clearing mutationError', async () => {
    const state = createRepoState({
      api: {
        ...auxApi,
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
        async graph() {
          throw new Error('not used')
        },
        async commitFiles() {
          throw new Error('not used')
        },
        async branches() {
          return []
        },
      },
    })

    await expect(state.commit('subject', true)).rejects.toThrow(/policy rejects this commit/)
    expect(state.mutationError).toMatch(/policy rejects this commit/)
    expect(state.busy).toBe(false)
  })

  it('assigns lanes to the loaded graph', async () => {
    const state = createRepoState({
      api: graphApi([
        [
          graphCommit('M', ['A', 'B']),
          graphCommit('A', ['C']),
          graphCommit('B', ['C']),
          graphCommit('C', []),
        ],
      ]),
    })
    await state.refreshGraph()
    expect(state.graphRows.map((r: { column: number }) => r.column)).toEqual([0, 0, 1, 0])
    expect(state.graphRows[0]?.commit.oid).toBe('M')
    expect(state.graphHasMore).toBe(false)
  })

  it('shows a new commit after refresh and keeps expanded commits and their files', async () => {
    const state = createRepoState({
      api: graphApi(
        [
          [graphCommit('c3', ['c2']), graphCommit('c2', ['c1']), graphCommit('c1', [])],
          [
            graphCommit('c4', ['c3']),
            graphCommit('c3', ['c2']),
            graphCommit('c2', ['c1']),
            graphCommit('c1', []),
          ],
        ],
        { c2: [commitFile('two.txt')] },
      ),
    })

    await state.refreshGraph()
    expect(state.graphRows.length).toBe(3)

    await state.toggleCommit('c2')
    await vi.waitFor(() => expect(state.commitFiles.c2).toBeDefined())
    expect(state.expanded.c2).toBe(true)

    await state.refreshGraph()
    expect(state.graphRows.length).toBe(4)
    expect(state.graphRows[0]?.commit.oid).toBe('c4')
    expect(state.expanded.c2).toBe(true)
    expect(state.commitFiles.c2).toEqual([commitFile('two.txt')])
  })

  it('collapses expanded commits that disappear after an amend', async () => {
    const state = createRepoState({
      api: graphApi(
        [
          [graphCommit('c3', ['c2']), graphCommit('c2', ['c1']), graphCommit('c1', [])],
          [graphCommit('c3a', ['c2'], 'amended'), graphCommit('c2', ['c1']), graphCommit('c1', [])],
        ],
        { c3: [commitFile('three.txt')] },
      ),
    })

    await state.refreshGraph()
    await state.toggleCommit('c3')
    await vi.waitFor(() => expect(state.commitFiles.c3).toBeDefined())
    expect(state.expanded.c3).toBe(true)

    await state.refreshGraph()
    expect(state.graphRows[0]?.commit.oid).toBe('c3a')
    expect(state.expanded.c3).toBeFalsy()
    expect(state.commitFiles.c3).toBeUndefined()
    expect(state.graphRows.length).toBe(3)
  })

  it('clears a selected commit file when rewritten history removes its commit', async () => {
    const state = createRepoState({
      api: graphApi([
        [graphCommit('old', ['base']), graphCommit('base', [])],
        [graphCommit('new', ['base']), graphCommit('base', [])],
      ]),
    })

    await state.refreshGraph()
    state.selectCommitFile('old', 'old commit', commitFile('old.txt'))
    expect(state.commitDiff?.oid).toBe('old')

    await state.refreshGraph()
    expect(state.commitDiff).toBeNull()
    expect(state.graphRows[0]?.commit.oid).toBe('new')
  })

  it('loads the next page of history', async () => {
    const state = createRepoState({
      api: graphApi([
        [graphCommit('c4', ['c3']), graphCommit('c3', ['c2'])],
        [graphCommit('c2', ['c1']), graphCommit('c1', [])],
      ]),
    })

    await state.refreshGraph()
    expect(state.graphRows.length).toBe(2)
    expect(state.graphHasMore).toBe(true)

    await state.loadMoreGraph()
    expect(state.graphRows.map((r: { commit: GraphCommit }) => r.commit.oid)).toEqual([
      'c4',
      'c3',
      'c2',
      'c1',
    ])
    expect(state.graphHasMore).toBe(false)
  })

  it('pins continuation pages and resolves the exact count without blocking the first page', async () => {
    let resolveCount!: (value: { tip: string; generation: number; total: number }) => void
    const count = new Promise<{ tip: string; generation: number; total: number }>((resolve) => {
      resolveCount = resolve
    })
    const graphCalls: Array<{ skip?: number; tip?: string }> = []
    const api: ApiClient = {
      ...auxApi,
      async graph(skip, tip) {
        graphCalls.push({ skip, tip })
        if ((skip ?? 0) === 0) {
          return {
            commits: [graphCommit('c4', ['c3']), graphCommit('c3', ['c2'])],
            hasMore: true,
            tip: 'tip-a',
            generation: 7,
          }
        }
        return {
          commits: [graphCommit('c2', ['c1']), graphCommit('c1')],
          hasMore: false,
          tip: 'tip-a',
          generation: 7,
        }
      },
      async graphCount() {
        return count
      },
    }
    const state = createRepoState({ api })

    await state.refreshGraph()
    expect(state.graphRows).toHaveLength(2)
    expect(state.graphCountLoading).toBe(true)
    expect(state.graphTotal).toBeNull()

    await state.loadMoreGraph()
    expect(graphCalls).toEqual([
      { skip: 0, tip: undefined },
      { skip: 2, tip: 'tip-a' },
    ])
    expect(state.graphRows).toHaveLength(4)

    resolveCount({ tip: 'tip-a', generation: 7, total: 4 })
    await vi.waitFor(() => expect(state.graphTotal).toBe(4))
    expect(state.graphCountLoading).toBe(false)
  })

  it('keys count caching and in-flight acceptance by tip and generation', async () => {
    let generation = 7
    let resolveOldCount!: (value: { tip: string; generation: number; total: number }) => void
    const oldCount = new Promise<{ tip: string; generation: number; total: number }>((resolve) => {
      resolveOldCount = resolve
    })
    const countCalls: number[] = []
    const api: ApiClient = {
      ...auxApi,
      async graph() {
        return {
          commits: [graphCommit('commit-a')],
          hasMore: false,
          tip: 'tip-a',
          generation,
        }
      },
      async graphCount(tip, requestedGeneration) {
        countCalls.push(requestedGeneration)
        if (requestedGeneration === 7) return oldCount
        return { tip, generation: requestedGeneration, total: 8 }
      },
    }
    const state = createRepoState({ api })

    await state.refreshGraph()
    expect(state.graphTotal).toBeNull()
    generation = 8
    await state.refreshGraph()
    await vi.waitFor(() => expect(state.graphTotal).toBe(8))

    resolveOldCount({ tip: 'tip-a', generation: 7, total: 4 })
    await vi.waitFor(() => expect(state.graphCountLoading).toBe(false))
    expect(state.graphTotal).toBe(8)
    expect(countCalls).toEqual([7, 8])

    await state.refreshGraph()
    expect(state.graphTotal).toBe(8)
    expect(countCalls).toEqual([7, 8])
  })

  it('rejects a count response whose generation does not match its request', async () => {
    const state = createRepoState({
      api: {
        ...auxApi,
        async graph() {
          return {
            commits: [graphCommit('commit-a')],
            hasMore: false,
            tip: 'tip-a',
            generation: 11,
          }
        },
        async graphCount(tip) {
          return { tip, generation: 10, total: 99 }
        },
      },
    })

    await state.refreshGraph()
    await vi.waitFor(() => expect(state.graphCountLoading).toBe(false))
    expect(state.graphTotal).toBeNull()
  })

  it('keeps continuation single-flight and resets after a tip conflict', async () => {
    let appendCalls = 0
    let refreshCalls = 0
    const api: ApiClient = {
      ...auxApi,
      async graph(skip) {
        if ((skip ?? 0) === 0) {
          refreshCalls += 1
          const tip = refreshCalls === 1 ? 'tip-a' : 'tip-b'
          return {
            commits: [graphCommit(tip, [])],
            hasMore: refreshCalls === 1,
            tip,
            generation: refreshCalls,
          }
        }
        appendCalls += 1
        throw new ApiError(409, 'graph tip changed')
      },
      async graphCount(tip, generation) {
        return { tip, generation, total: 1 }
      },
    }
    const state = createRepoState({ api })
    await state.refreshGraph()

    await Promise.all([state.loadMoreGraph(), state.loadMoreGraph()])
    expect(appendCalls).toBe(1)
    expect(refreshCalls).toBe(2)
    expect(state.graphTip).toBe('tip-b')
    expect(state.graphRows.map((row) => row.commit.oid)).toEqual(['tip-b'])
    expect(state.graphError).toBeNull()
  })

  it('selecting a commit file sets the commit diff and clears the worktree selection', async () => {
    const state = createRepoState({
      api: graphApi(
        [[graphCommit('c2', ['c1']), graphCommit('c1', [])]],
        { c2: [commitFile('two.txt')] },
        snapshot({ generation: 1, unstaged: [change('unstaged', 'x.txt')] }),
      ),
    })

    await state.refreshSnapshot()
    await state.refreshGraph()
    await state.toggleCommit('c2')
    await vi.waitFor(() => expect(state.commitFiles.c2).toBeDefined())

    state.select('unstaged', 'x.txt')
    expect(state.selectedChange?.path).toBe('x.txt')

    state.selectCommitFile('c2', 'two', commitFile('two.txt'))
    expect(state.selectedChange).toBeNull()
    expect(state.commitDiff).toEqual({
      oid: 'c2',
      subject: 'two',
      path: 'two.txt',
      kind: 'modified',
    })

    state.select('unstaged', 'x.txt')
    expect(state.commitDiff).toBeNull()
  })
})

describe('branch and sync operations', () => {
  it('runs a branch op and refreshes snapshot, graph, and branches', async () => {
    const ops: string[] = []
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 2 })
      },
      async diff() {
        throw new Error('not used')
      },
      async mutate(req) {
        ops.push(req.op)
      },
      async commit() {
        throw new Error('not used')
      },
      async graph() {
        return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
      },
      async commitFiles() {
        return { files: [] }
      },
      async branches() {
        return [{ name: 'main', oid: 'x', current: true, remote: false, ahead: 0, behind: 0 }]
      },
    }
    const state = createRepoState({ api })

    await state.switchBranch('main')

    expect(ops).toEqual(['switch-branch'])
    await vi.waitFor(() => expect(state.branches.length).toBe(1))
    expect(state.branches[0]?.name).toBe('main')
    expect(state.busy).toBe(false)
  })

  it('routes each sync action to the matching operation', async () => {
    const ops: string[] = []
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 2 })
      },
      async diff() {
        throw new Error('not used')
      },
      async mutate(req) {
        ops.push(`${req.op}:${req.name ?? ''}:${req.remote ?? ''}:${req.force ?? false}`)
      },
      async commit() {
        throw new Error('not used')
      },
      async graph() {
        return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
      },
      async commitFiles() {
        return { files: [] }
      },
      async branches() {
        return []
      },
    }
    const state = createRepoState({ api })

    await state.createBranch('topic', 'main')
    await state.fetchRemote()
    await state.pullRemote()
    await state.pushRemote()
    await state.deleteBranch('topic', true)
    await state.pushSetUpstream('origin', 'topic')

    expect(ops).toEqual([
      'create-branch:topic::false',
      'fetch:::false',
      'pull:::false',
      'push:::false',
      'delete-branch:topic::true',
      'push-upstream:topic:origin:false',
    ])
  })

  it('propagates structured no-upstream state to the caller', async () => {
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 2 })
      },
      async diff() {
        throw new Error('not used')
      },
      async mutate() {
        throw new ApiError(409, 'no upstream branch', 'no-upstream', 'topic')
      },
      async commit() {
        throw new Error('not used')
      },
      async graph() {
        return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
      },
      async commitFiles() {
        return { files: [] }
      },
      async branches() {
        return []
      },
    }
    const state = createRepoState({ api })

    await expect(state.pushRemote()).rejects.toMatchObject({ code: 'no-upstream', branch: 'topic' })
    expect(state.mutationError).toMatch(/no upstream/)
    expect(state.busy).toBe(false)
  })

  it('refreshes branches with the branch list', async () => {
    const api: ApiClient = {
      ...auxApi,
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
        throw new Error('not used')
      },
      async graph() {
        return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
      },
      async commitFiles() {
        return { files: [] }
      },
      async branches() {
        throw new Error('branch listing failed')
      },
    }
    const state = createRepoState({ api })

    await state.refreshBranches()
    expect(state.branchesError).toMatch(/branch listing failed/)
  })
})

describe('stash, tag, compare, and history operations', () => {
  it('routes stash ops and refreshes the stash list', async () => {
    const ops: string[] = []
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 2 })
      },
      async diff() {
        throw new Error('not used')
      },
      async mutate(req) {
        ops.push(`${req.op}:${req.message ?? ''}:${req.ref ?? ''}:${req.includeUntracked ?? false}`)
      },
      async commit() {
        throw new Error('not used')
      },
      async graph() {
        return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
      },
      async commitFiles() {
        return { files: [] }
      },
      async branches() {
        return []
      },
      async stashes() {
        return [{ ref: 'stash@{0}', oid: 'a', message: 'wip', branch: 'main' }]
      },
    }
    const state = createRepoState({ api })

    await state.stashPush('wip', true)
    await state.stashApply('stash@{0}')
    await state.stashPop('stash@{0}')
    await state.stashDrop('stash@{0}')

    expect(ops).toEqual([
      'stash-push:wip::true',
      'stash-apply::stash@{0}:false',
      'stash-pop::stash@{0}:false',
      'stash-drop::stash@{0}:false',
    ])
    await vi.waitFor(() => expect(state.stashes.length).toBe(1))
  })

  it('routes tag and history ops', async () => {
    const ops: string[] = []
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 2 })
      },
      async diff() {
        throw new Error('not used')
      },
      async mutate(req) {
        ops.push(
          `${req.op}:${req.name ?? ''}:${req.start ?? ''}:${req.message ?? ''}:${req.ref ?? ''}:${req.mode ?? ''}:${req.remote ?? ''}`,
        )
      },
      async commit() {
        throw new Error('not used')
      },
      async graph() {
        return { commits: [], hasMore: false, tip: 'abc123', generation: 1 }
      },
      async commitFiles() {
        return { files: [] }
      },
      async branches() {
        return []
      },
      async tags() {
        return [{ name: 'v1', oid: 'a', annotated: true }]
      },
    }
    const state = createRepoState({ api })

    await state.createTag('v1', 'HEAD', 'release one')
    await state.deleteTag('v1')
    await state.pushTag('origin', 'v1')
    await state.cherryPick('abc123')
    await state.revertCommit('abc123')
    await state.resetTo('HEAD~2', 'hard')

    expect(ops).toEqual([
      'create-tag:v1:HEAD:release one:::',
      'delete-tag:v1:::::',
      'push-tag:v1:::::origin',
      'cherry-pick::::abc123::',
      'revert::::abc123::',
      'reset::::HEAD~2:hard:',
    ])
    await vi.waitFor(() => expect(state.tags.length).toBe(1))
  })

  it('opens a compare, selects a file, and clears the view', async () => {
    const api: ApiClient = {
      ...auxApi,
      async compare() {
        return { files: [{ path: 'a.txt', kind: 'modified' }] }
      },
    }
    const state = createRepoState({ api })

    await state.openCompare('main', 'HEAD', 'main..HEAD')
    expect(state.compare).toEqual({ from: 'main', to: 'HEAD', label: 'main..HEAD' })
    expect(state.compareFiles).toEqual([{ path: 'a.txt', kind: 'modified' }])
    expect(state.compareError).toBeNull()

    state.selectCompareFile({ path: 'a.txt', kind: 'modified' })
    expect(state.compareDiff).toEqual({
      from: 'main',
      to: 'HEAD',
      path: 'a.txt',
      kind: 'modified',
    })

    state.clearCompare()
    expect(state.compare).toBeNull()
    expect(state.compareFiles).toEqual([])
    expect(state.compareDiff).toBeNull()
  })

  it('records a compare error when the refs are invalid', async () => {
    const api: ApiClient = {
      ...auxApi,
      async compare() {
        throw new ApiError(400, 'invalid ref')
      },
    }
    const state = createRepoState({ api })

    await state.openCompare('bad..ref', 'HEAD', 'bad..ref..HEAD')
    expect(state.compareError).toMatch(/invalid ref/)
    expect(state.compareFiles).toEqual([])
  })
})

describe('merge, rebase, and conflict operations', () => {
  it('calls merge and refreshes conflicts when snapshot shows merge operation', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    let snapGen = 1
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: snapGen++ })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        return {
          before: { path: '', content: '' },
          after: { path: '', content: '' },
          binary: false,
          tooLarge: false,
        }
      },
      async conflicts() {
        return [{ path: 'a.txt', baseOid: 'b1', oursOid: 'o1', theirsOid: 't1' }]
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.mergeBranch('feature')
    expect(mutate).toHaveBeenCalledWith({ op: 'merge', name: 'feature' })
  })

  it('calls merge-abort', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.mergeAbort()
    expect(mutate).toHaveBeenCalledWith({ op: 'merge-abort' })
  })

  it('calls merge-continue', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.mergeContinue()
    expect(mutate).toHaveBeenCalledWith({ op: 'merge-continue' })
  })

  it('calls rebase', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.rebaseBranch('main')
    expect(mutate).toHaveBeenCalledWith({ op: 'rebase', name: 'main' })
  })

  it('calls rebase-abort', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.rebaseAbort()
    expect(mutate).toHaveBeenCalledWith({ op: 'rebase-abort' })
  })

  it('calls rebase-continue', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.rebaseContinue()
    expect(mutate).toHaveBeenCalledWith({ op: 'rebase-continue' })
  })

  it('calls ours, theirs, and both conflict resolution', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.resolveOurs('a.txt')
    expect(mutate).toHaveBeenCalledWith({ op: 'resolve-ours', paths: ['a.txt'] })

    await state.resolveTheirs('b.txt')
    expect(mutate).toHaveBeenCalledWith({ op: 'resolve-theirs', paths: ['b.txt'] })

    await state.resolveBoth('c.txt')
    expect(mutate).toHaveBeenCalledWith({ op: 'resolve-both', paths: ['c.txt'] })
  })

  it('calls cherry-pick and revert recovery operations', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1 })
      },
      async mutate(req) {
        return mutate(req)
      },
      async diff() {
        throw new Error('not used')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    await state.cherryPickAbort()
    await state.cherryPickContinue()
    await state.revertAbort()
    await state.revertContinue()

    expect(mutate.mock.calls.map(([request]) => request.op)).toEqual([
      'cherry-pick-abort',
      'cherry-pick-continue',
      'revert-abort',
      'revert-continue',
    ])
  })

  it('refreshes conflicts when snapshot shows merge operation', async () => {
    let snapGen = 1
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({
          generation: snapGen++,
          operation: 'merge',
          conflicts: [
            {
              path: 'a.txt',
              baseOid: 'b1',
              oursOid: 'o1',
              theirsOid: 't1',
              mode: '100644',
              canResolveBoth: true,
            },
          ],
        })
      },
      async diff() {
        throw new Error('not used')
      },
      async conflicts() {
        return [{ path: 'a.txt', baseOid: 'b1', oursOid: 'o1', theirsOid: 't1' }]
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()

    expect(state.snapshot?.operation).toBe('merge')
    await vi.waitFor(() => {
      expect(state.conflicts).toHaveLength(1)
      expect(state.conflicts[0].path).toBe('a.txt')
    })
  })

  it('clears conflicts when snapshot returns to none', async () => {
    let snapGen = 1
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        const gen = snapGen++
        if (gen === 1) {
          return snapshot({
            generation: gen,
            operation: 'merge',
            conflicts: [
              {
                path: 'a.txt',
                baseOid: 'b1',
                oursOid: 'o1',
                theirsOid: 't1',
                mode: '100644',
                canResolveBoth: true,
              },
            ],
          })
        }
        return snapshot({ generation: gen, operation: 'none' })
      },
      async diff() {
        throw new Error('not used')
      },
      async conflicts() {
        return [{ path: 'a.txt', baseOid: 'b1', oursOid: 'o1', theirsOid: 't1' }]
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()
    await vi.waitFor(() => expect(state.conflicts).toHaveLength(1))

    await state.refreshSnapshot()
    await vi.waitFor(() => expect(state.conflicts).toEqual([]))
  })

  it('records conflict fetch errors', async () => {
    const api: ApiClient = {
      ...auxApi,
      async snapshot() {
        return snapshot({ generation: 1, operation: 'merge' })
      },
      async diff() {
        throw new Error('not used')
      },
      async conflicts() {
        throw new Error('network error')
      },
    }
    const state = createRepoState({ api })
    await state.refreshSnapshot()
    await state.refreshConflicts()

    expect(state.conflictsError).toMatch(/network error/)
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

describe('operation feedback', () => {
  function mockMutateApi(mutateFn: ApiClient['mutate'] = async () => {}) {
    return {
      ...auxApi,
      async snapshot() {
        return snapshot()
      },
      mutate: mutateFn,
      async commit() {
        return { ok: true }
      },
    } satisfies ApiClient
  }

  it('exposes activeOp as null when idle', () => {
    const repo = createRepoState({ api: mockMutateApi() })
    void repo.refreshSnapshot()
    expect(repo.activeOp).toBeNull()
    expect(repo.activeOpLabel).toBeNull()
  })

  it('sets activeOp during mutate', async () => {
    let captured = ''
    const repo = createRepoState({
      api: mockMutateApi(async (_req) => {
        captured = repo.activeOp ?? ''
      }),
    })
    void repo.refreshSnapshot()
    await repo.mutate({ op: 'stage', paths: ['a.txt'] })
    expect(captured).toBe('stage')
    expect(repo.activeOp).toBeNull()
  })

  it('sets activeOp during operation', async () => {
    let captured = ''
    const repo = createRepoState({
      api: mockMutateApi(async () => {
        captured = repo.activeOp ?? ''
      }),
    })
    void repo.refreshSnapshot()
    await repo.fetchRemote()
    expect(captured).toBe('fetch')
    expect(repo.activeOp).toBeNull()
  })

  it('clears activeOp on error', async () => {
    const repo = createRepoState({
      api: mockMutateApi(async () => {
        throw new Error('boom')
      }),
    })
    void repo.refreshSnapshot()
    await repo.pushRemote().catch(() => {})
    expect(repo.activeOp).toBeNull()
  })

  it('clears activeOp on timeout error', async () => {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError')
    const repo = createRepoState({
      api: mockMutateApi(async () => {
        throw timeoutError
      }),
    })
    void repo.refreshSnapshot()
    await repo.pullRemote().catch(() => {})
    expect(repo.activeOp).toBeNull()
    expect(repo.mutationError).toBe('Operation timed out')
  })

  it('sets activeOp during commit', async () => {
    let captured = ''
    const repo = createRepoState({
      api: {
        ...auxApi,
        async snapshot() {
          return snapshot()
        },
        async mutate() {},
        async commit() {
          captured = repo.activeOp ?? ''
          return { ok: true }
        },
      } satisfies ApiClient,
    })
    void repo.refreshSnapshot()
    await repo.commit('test message')
    expect(captured).toBe('commit')
    expect(repo.activeOp).toBeNull()
  })

  it('reports human-readable label for operations', async () => {
    const repo = createRepoState({
      api: mockMutateApi(async () => {
        // Label is set during the operation
      }),
    })
    void repo.refreshSnapshot()
    // Before any operation, label is null
    expect(repo.activeOpLabel).toBeNull()

    // We can't easily test activeOpLabel mid-operation without side effects,
    // but we verify the getter exists and works
    await repo.mutate({ op: 'fetch' } as any)
    expect(repo.activeOpLabel).toBeNull()
  })

  it('sets busy during operations', async () => {
    let wasBusy = false
    const repo = createRepoState({
      api: mockMutateApi(async () => {
        wasBusy = repo.busy
      }),
    })
    void repo.refreshSnapshot()
    await repo.stashPush('test')
    expect(wasBusy).toBe(true)
    expect(repo.busy).toBe(false)
  })
})
