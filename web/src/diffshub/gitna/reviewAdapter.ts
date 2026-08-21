import {
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
} from '@pierre/diffs'

import {
  appendFileDiffToDiffsHubData,
  createDiffsHubDataAccumulator,
  snapshotDiffsHubData,
  type LoadedDiffsHubData,
} from '../lib/diffsHubDataAccumulator'
import type { ReviewResponse } from '../../lib/types'

function reviewIdentityKey(review: ReviewResponse): string {
  const { identity } = review
  return [identity.scope, identity.commit, identity.from, identity.to]
    .filter(Boolean)
    .join(':')
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
        supplement.diff.binary || supplement.diff.tooLarge
          ? ''
          : supplement.diff.after.content,
      lang: supplement.diff.after.language as FileContents['lang'],
      cacheKey: `${cacheKey}:${supplement.path}`,
    }
    const fileDiff = parseDiffFromFile(null, after, undefined, true)
    appendFileDiffToDiffsHubData(accumulator, fileDiff, undefined)
  }

  return snapshotDiffsHubData(accumulator)
}
