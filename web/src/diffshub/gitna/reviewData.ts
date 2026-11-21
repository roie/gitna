// Modified by Gitna: accumulate local streamed reviews and canonical file identities.
import { type ChangeTypes, type CodeViewItem, type FileDiffMetadata } from '@pierre/diffs'
import type { GitStatusEntry } from '@pierre/trees'

import { mapChangeTypeToGitStatus } from '../lib/mapChangeTypeToGitStatus'
import type {
  CommentMetadata,
  DiffsHubCommentFileByItemId,
  DiffsHubCommentSidebarFile,
  DiffsHubDiffStats,
  DiffsHubFileTreeSource,
} from '../lib/types'

export interface ReviewAccumulator {
  diffStats: DiffsHubDiffStats
  gitStatusByPath: Map<string, GitStatusEntry>
  itemIdToFile: Map<string, DiffsHubCommentSidebarFile>
  items: CodeViewItem<CommentMetadata>[]
  nextCollisionSuffixByBase: Map<string, number>
  pendingItems: CodeViewItem<CommentMetadata>[]
  pendingItemById: Map<string, CodeViewItem<CommentMetadata>>
  pathToItemId: Map<string, string>
  pathStateByTreePath: Map<string, CodeViewPathState>
  paths: string[]
}

export interface ReviewItemRename {
  oldId: string
  newId: string
}

interface CodeViewPathState {
  currentItem: CodeViewItem<CommentMetadata>
  currentItemId: string
  currentType: ChangeTypes
  sawDeleted: boolean
}

export interface LoadedReviewData {
  itemIdToFile: DiffsHubCommentFileByItemId
  diffStats: DiffsHubDiffStats
  items: CodeViewItem<CommentMetadata>[]
  treeSource: DiffsHubFileTreeSource
}

export function createReviewAccumulator(): ReviewAccumulator {
  return {
    diffStats: {
      addedLines: 0,
      deletedLines: 0,
      fileCount: 0,
      totalLinesOfCode: 0,
    },
    gitStatusByPath: new Map(),
    itemIdToFile: new Map(),
    items: [],
    nextCollisionSuffixByBase: new Map(),
    pendingItems: [],
    pendingItemById: new Map(),
    pathToItemId: new Map(),
    pathStateByTreePath: new Map(),
    paths: [],
  }
}

export function appendReviewDiff(
  accumulator: ReviewAccumulator,
  fileDiff: FileDiffMetadata,
  treePathPrefix: string | undefined,
): ReviewItemRename | undefined {
  const { diffStats } = accumulator
  diffStats.fileCount++
  diffStats.totalLinesOfCode += fileDiff.unifiedLineCount
  for (const hunk of fileDiff.hunks) {
    diffStats.addedLines += hunk.additionLines
    diffStats.deletedLines += hunk.deletionLines
  }

  const path = fileDiff.name
  const treePath = treePathPrefix == null ? path : `${treePathPrefix}/${path}`
  const previousPathState =
    path.length === 0 ? undefined : accumulator.pathStateByTreePath.get(treePath)
  const itemIdRename =
    previousPathState == null
      ? undefined
      : renameCurrentPathItem(accumulator, treePath, previousPathState)
  const id = accumulator.itemIdToFile.has(treePath)
    ? createFallbackItemId(accumulator, treePath)
    : treePath
  const fileOrder = accumulator.items.length

  const item: CodeViewItem<CommentMetadata> = {
    id,
    type: 'diff',
    fileDiff,
    version: 0,
  }
  accumulator.items.push(item)
  accumulator.pendingItems.push(item)
  accumulator.pendingItemById.set(id, item)

  accumulator.itemIdToFile.set(id, { fileOrder, path })
  if (path.length === 0) {
    return itemIdRename
  }

  if (previousPathState == null) {
    accumulator.paths.push(treePath)
  }
  accumulator.pathToItemId.set(treePath, id)
  updateGitStatusByPath(
    accumulator,
    treePath,
    fileDiff.type,
    previousPathState?.sawDeleted === true,
  )
  accumulator.pathStateByTreePath.set(treePath, {
    currentItem: item,
    currentItemId: id,
    currentType: fileDiff.type,
    sawDeleted: previousPathState?.sawDeleted === true || fileDiff.type === 'deleted',
  })

  return itemIdRename
}

export function takePendingReviewItems(
  accumulator: ReviewAccumulator,
): CodeViewItem<CommentMetadata>[] {
  const { pendingItems } = accumulator
  accumulator.pendingItems = []
  accumulator.pendingItemById.clear()
  return pendingItems
}

// Moves the current CodeView item for a path off the canonical tree id so the
// next diff entry for that same path can own tree navigation without rebuilding.
function renameCurrentPathItem(
  accumulator: ReviewAccumulator,
  treePath: string,
  pathState: CodeViewPathState,
): ReviewItemRename | undefined {
  const oldId = pathState.currentItemId
  const newId = createSupersededItemId(accumulator, treePath, pathState.currentType)
  pathState.currentItem.id = newId
  pathState.currentItemId = newId

  const file = accumulator.itemIdToFile.get(oldId)
  if (file != null) {
    accumulator.itemIdToFile.delete(oldId)
    accumulator.itemIdToFile.set(newId, file)
  }

  const pendingItem = accumulator.pendingItemById.get(oldId)
  if (pendingItem != null) {
    accumulator.pendingItemById.delete(oldId)
    accumulator.pendingItemById.set(newId, pendingItem)
    return undefined
  }

  return { oldId, newId }
}

function createSupersededItemId(
  accumulator: ReviewAccumulator,
  treePath: string,
  changeType: ChangeTypes,
): string {
  const semanticSuffix = changeType === 'deleted' ? '?deleted' : '?previous'
  return createUniqueItemId(accumulator, `${treePath}${semanticSuffix}`)
}

function createFallbackItemId(accumulator: ReviewAccumulator, treePath: string): string {
  return createUniqueItemId(accumulator, `${treePath}?2`)
}

// Resolves rare id collisions by advancing a per-base suffix instead of scanning
// accumulated items.
function createUniqueItemId(accumulator: ReviewAccumulator, baseId: string): string {
  if (!accumulator.itemIdToFile.has(baseId)) {
    return baseId
  }

  let suffix = accumulator.nextCollisionSuffixByBase.get(baseId) ?? 2
  let itemId = `${baseId}-${suffix}`
  while (accumulator.itemIdToFile.has(itemId)) {
    suffix++
    itemId = `${baseId}-${suffix}`
  }
  accumulator.nextCollisionSuffixByBase.set(baseId, suffix + 1)
  return itemId
}

// Maintains the file tree status for a real path while repeated patch entries
// replace the path's final CodeView item.
function updateGitStatusByPath(
  accumulator: ReviewAccumulator,
  treePath: string,
  changeType: ChangeTypes,
  hadDeletedEntry: boolean,
): void {
  if (hadDeletedEntry && changeType !== 'deleted') {
    accumulator.gitStatusByPath.delete(treePath)
    return
  }

  // Modified files are excluded so they render as the visual default. Only
  // added, deleted, and renamed files retain status indicators.
  const gitStatusEntry = mapChangeTypeToGitStatus(changeType)
  if (gitStatusEntry === 'modified') {
    accumulator.gitStatusByPath.delete(treePath)
  } else {
    const previousStatus = accumulator.gitStatusByPath.get(treePath)?.status
    if (previousStatus === gitStatusEntry) {
      return
    }

    const entry = {
      path: treePath,
      status: gitStatusEntry,
    }
    accumulator.gitStatusByPath.set(treePath, entry)
  }
}

export function snapshotReviewData(accumulator: ReviewAccumulator): LoadedReviewData {
  return {
    itemIdToFile: new Map(accumulator.itemIdToFile),
    diffStats: { ...accumulator.diffStats },
    items: accumulator.items.slice(),
    treeSource: {
      gitStatus: Array.from(accumulator.gitStatusByPath.values()),
      pathCount: accumulator.paths.length,
      paths: accumulator.paths,
      pathToItemId: accumulator.pathToItemId,
    },
  }
}
