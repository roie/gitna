import { parseDiffFromFile, parsePatchFiles, type FileContents } from '@pierre/diffs'

import {
  appendFileDiffToDiffsHubData,
  createDiffsHubDataAccumulator,
  snapshotDiffsHubData,
  type LoadedDiffsHubData,
} from '../lib/diffsHubDataAccumulator'
import type { FileDiff, ReviewResponse } from '../../lib/types'

function reviewIdentityKey(review: ReviewResponse): string {
  const { identity } = review
  return [identity.scope, identity.commit, identity.from, identity.to].filter(Boolean).join(':')
}

export function adaptGitnaFile(diff: FileDiff, generation: number): LoadedDiffsHubData {
  const path = diff.after.path || diff.before.path
  const contents = diff.binary || diff.tooLarge ? '' : diff.after.content
  const file: FileContents = {
    name: path,
    contents,
    lang: diff.after.language as FileContents['lang'],
    cacheKey: `file:${generation}:${path}`,
  }
  const lineCount =
    contents.length === 0 ? 0 : contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0)
  return {
    diffStats: { addedLines: 0, deletedLines: 0, fileCount: 1, totalLinesOfCode: lineCount },
    itemIdToFile: new Map([[path, { fileOrder: 0, path }]]),
    items: [{ id: path, type: 'file', file, version: generation }],
    treeSource: {
      gitStatus: [],
      pathCount: 1,
      paths: [path],
      pathToItemId: new Map([[path, path]]),
    },
  }
}

/**
 * Typed Gitna boundary for the donor viewer. Gitna supplies one bounded
 * patch plus supplements; Pierre remains responsible for parsing every diff
 * and constructing the CodeView metadata consumed by donor components.
 */
export function adaptGitnaReview(review: ReviewResponse): LoadedDiffsHubData {
  const accumulator = createDiffsHubDataAccumulator()
  const cacheKey = `${reviewIdentityKey(review)}:${review.generation}`

  if (review.patch.length > 0) {
    const parsed = parsePatchFiles(review.patch, cacheKey, true)
    for (const patch of parsed) {
      for (const fileDiff of patch.files) {
        appendFileDiffToDiffsHubData(accumulator, fileDiff, undefined)
      }
    }
  }

  for (const supplement of review.supplements) {
    const after: FileContents = {
      name: supplement.path,
      contents:
        supplement.diff.binary || supplement.diff.tooLarge ? '' : supplement.diff.after.content,
      lang: supplement.diff.after.language as FileContents['lang'],
      cacheKey: `${cacheKey}:${supplement.path}`,
    }
    const before: FileContents | null =
      supplement.kind === 'added' || supplement.kind === 'untracked'
        ? null
        : {
            name: supplement.diff.before.path || supplement.path,
            contents:
              supplement.diff.binary || supplement.diff.tooLarge
                ? ''
                : supplement.diff.before.content,
            lang: supplement.diff.before.language as FileContents['lang'],
            cacheKey: `${cacheKey}:${supplement.path}:before`,
          }
    const fileDiff = parseDiffFromFile(before, after, undefined, true)
    appendFileDiffToDiffsHubData(accumulator, fileDiff, undefined)
  }

  return snapshotDiffsHubData(accumulator)
}
