import type { GitStatus, GitStatusEntry } from '@pierre/trees'
import type { FileTreeSource } from './review-types'
import type { ChangeKind } from './types'

export interface TreeFile {
  kind: ChangeKind
  oldPath?: string
  path: string
}

export function gitStatus(kind: ChangeKind): GitStatus {
  if (kind === 'added') return 'added'
  if (kind === 'untracked') return 'untracked'
  if (kind === 'deleted') return 'deleted'
  if (kind === 'renamed') return 'renamed'
  return 'modified'
}

export function createRepositoryListSource(
  paths: readonly string[],
  changes: readonly TreeFile[],
  ignored: ReadonlySet<string>,
): FileTreeSource {
  const statusesByPath = new Map<string, GitStatus>([
    ...[...ignored].map((path) => [path, 'ignored'] as const),
    ...changes.map((change) => [change.path, gitStatus(change.kind)] as const),
  ])
  const displayPaths: string[] = []
  const pathToItemId = new Map<string, string>()
  const itemIdToPath = new Map<string, string>()
  const used = new Set<string>()
  for (const path of paths) {
    if (path.endsWith('/')) continue
    const base = path.replaceAll('/', ' › ')
    let display = base
    while (used.has(display)) display += '\u2063'
    used.add(display)
    displayPaths.push(display)
    pathToItemId.set(display, path)
    itemIdToPath.set(path, display)
  }
  return {
    gitStatus: displayPaths.flatMap((display) => {
      const original = pathToItemId.get(display)!
      const status = statusesByPath.get(original)
      return status == null ? [] : [{ path: display, status }]
    }),
    pathCount: displayPaths.length,
    paths: displayPaths,
    pathToItemId,
    itemIdToPath,
  }
}

export function createTreeSource(files: readonly TreeFile[]): FileTreeSource {
  const byPath = new Map<string, TreeFile>()
  for (const file of files) byPath.set(file.path, file)
  const paths = [...byPath.keys()].sort()
  const statuses: GitStatusEntry[] = paths.map((path) => ({
    path,
    status: gitStatus(byPath.get(path)!.kind),
  }))
  return {
    gitStatus: statuses,
    pathCount: paths.length,
    paths,
    pathToItemId: new Map(paths.map((path) => [path, path])),
  }
}
