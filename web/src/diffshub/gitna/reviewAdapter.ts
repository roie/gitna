import {
  parseDiffFromFile,
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileContents,
  type LineAnnotation,
} from '@pierre/diffs'

import {
  appendFileDiffToDiffsHubData,
  createDiffsHubDataAccumulator,
  snapshotDiffsHubData,
  takePendingDiffsHubItems,
  type DiffsHubDataAccumulator,
  type LoadedDiffsHubData,
} from '../lib/diffsHubDataAccumulator'
import type { CommentMetadata, ImageAnnotationMetadata } from '../lib/types'
import type { FileDiff, FileVersion, ReviewResponse, WorktreeFile } from '../../lib/types'

function imageMetadata(version: FileVersion, alt: string): ImageAnnotationMetadata | null {
  return version.image == null
    ? null
    : { kind: 'image', key: `image:${version.path}:${alt}`, alt, image: version.image }
}

function fileImageAnnotations(diff: FileDiff, path: string): LineAnnotation<CommentMetadata>[] {
  const metadata = imageMetadata(diff.after.image == null ? diff.before : diff.after, path)
  return metadata == null ? [] : [{ lineNumber: 0, metadata }]
}

export function diffImageAnnotations(
  diff: FileDiff,
  path: string,
): DiffLineAnnotation<CommentMetadata>[] {
  const annotations: DiffLineAnnotation<CommentMetadata>[] = []
  const before = imageMetadata(diff.before, `Previous image for ${path}`)
  const after = imageMetadata(diff.after, `Image preview for ${path}`)
  if (before != null) annotations.push({ lineNumber: 0, side: 'deletions', metadata: before })
  if (after != null) annotations.push({ lineNumber: 0, side: 'additions', metadata: after })
  return annotations
}

function reviewIdentityKey(review: ReviewResponse): string {
  const { identity } = review
  return [identity.scope, identity.commit, identity.from, identity.to].filter(Boolean).join(':')
}

export function adaptWorktreeFile(
  source: WorktreeFile,
  generation: number,
  draft?: FileContents,
): LoadedDiffsHubData {
  const file: FileContents = draft ?? {
    name: source.path,
    contents: source.content,
    cacheKey: `worktree:${source.hash}:${source.path}`,
  }
  const lineCount =
    file.contents.length === 0
      ? 0
      : file.contents.split('\n').length - (file.contents.endsWith('\n') ? 1 : 0)
  return {
    diffStats: { addedLines: 0, deletedLines: 0, fileCount: 1, totalLinesOfCode: lineCount },
    itemIdToFile: new Map([[source.path, { fileOrder: 0, path: source.path }]]),
    items: [{ id: source.path, type: 'file', file, edit: true, version: generation }],
    treeSource: {
      gitStatus: [],
      pathCount: 1,
      paths: [source.path],
      pathToItemId: new Map([[source.path, source.path]]),
    },
  }
}

export function adaptWorktreeComparison(
  diff: FileDiff,
  generation: number,
  leftDraft?: FileContents,
  rightDraft?: FileContents,
): LoadedDiffsHubData {
  const before: FileContents = leftDraft ?? {
    name: diff.before.path,
    contents: diff.before.content,
    lang: diff.before.language as FileContents['lang'],
    cacheKey: `worktree-compare:${generation}:${diff.before.path}`,
  }
  const after: FileContents = rightDraft ?? {
    name: diff.after.path,
    contents: diff.after.content,
    lang: diff.after.language as FileContents['lang'],
    cacheKey: `worktree-compare:${generation}:${diff.after.path}`,
  }
  const fileDiff = parseDiffFromFile(before, after, undefined, true)
  const accumulator = createDiffsHubDataAccumulator()
  appendFileDiffToDiffsHubData(accumulator, fileDiff, undefined)
  const item = accumulator.items.at(-1)
  if (item?.type === 'diff') {
    item.version = generation
    const annotations = diffImageAnnotations(diff, diff.after.path)
    if (annotations.length > 0) item.annotations = annotations
  }
  return snapshotDiffsHubData(accumulator)
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
    items: [
      {
        id: path,
        type: 'file',
        file,
        annotations: fileImageAnnotations(diff, path),
        version: generation,
      },
    ],
    treeSource: {
      gitStatus: [],
      pathCount: 1,
      paths: [path],
      pathToItemId: new Map([[path, path]]),
    },
  }
}

export interface GitnaReviewAccumulator {
  accumulator: DiffsHubDataAccumulator
  cacheKey: string
  generation: number
}

export function createGitnaReviewAccumulator(review: ReviewResponse): GitnaReviewAccumulator {
  return {
    accumulator: createDiffsHubDataAccumulator(),
    cacheKey: `${reviewIdentityKey(review)}:${review.generation}`,
    generation: review.generation,
  }
}

/** Appends one bounded server page while Pierre retains parsing and item ownership. */
export function appendGitnaReviewPage(
  assembly: GitnaReviewAccumulator,
  review: ReviewResponse,
): { data: LoadedDiffsHubData; pendingItems: LoadedDiffsHubData['items'] } {
  if (review.generation !== assembly.generation) {
    throw new Error('Review changed while additional files were loading')
  }
  const { accumulator } = assembly
  if (review.patch.length > 0) {
    const parsed = parsePatchFiles(review.patch, assembly.cacheKey, true)
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
      cacheKey: `${assembly.cacheKey}:${supplement.path}`,
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
            cacheKey: `${assembly.cacheKey}:${supplement.path}:before`,
          }
    const fileDiff = parseDiffFromFile(before, after, undefined, true)
    appendFileDiffToDiffsHubData(accumulator, fileDiff, undefined)
    const item = accumulator.items.at(-1)
    const annotations = diffImageAnnotations(supplement.diff, supplement.path)
    if (item?.type === 'diff' && annotations.length > 0) item.annotations = annotations
  }

  const pendingItems = takePendingDiffsHubItems(accumulator)
  for (const item of pendingItems) item.version = review.generation
  return { data: snapshotDiffsHubData(accumulator), pendingItems }
}

export function adaptGitnaReview(review: ReviewResponse): LoadedDiffsHubData {
  return appendGitnaReviewPage(createGitnaReviewAccumulator(review), review).data
}
