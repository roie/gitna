import type { FileContents } from '@pierre/diffs'
import type { CodeViewHandle } from '@pierre/diffs/react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ApiError, type ApiClient, type ReviewRequest } from '../../lib/api'
import type { CommentMetadata, ViewerLoadState } from '../../lib/review-types'
import type { DiffScope, FileDiff, ReviewIdentity } from '../../lib/types'
import type { GitnaRepository, RepositoryFileComparison } from '../../repository/repository'
import { nativeMediaKind } from './preview/media-preview'
import {
  appendGitnaReviewPage,
  createGitnaReviewAccumulator,
  adaptWorktreeComparison,
  draftDiffItem,
  type GitnaReviewAccumulator,
} from './review-adapter'
import type { LoadedReviewData } from './review-data'
import { getNextItemVersion } from './viewer'

export interface ReviewTarget {
  comparison?: RepositoryFileComparison
  filePath?: string
  key: string
  oldPath?: string
  request?: ReviewRequest
  selectedPath?: string
}

interface ReviewPagingState {
  assembly: GitnaReviewAccumulator
  controller: AbortController
  cursor?: string
  loadedPages: number
  loading: boolean
  request: ReviewRequest
  targetKey: string
}

const rasterImagePattern = /\.(?:gif|jpe?g|png|webp)$/i

function keepDraftItems(
  viewer: CodeViewHandle<CommentMetadata, undefined>,
  current: LoadedReviewData,
  refreshed: LoadedReviewData,
): LoadedReviewData {
  const ids = new Set(refreshed.items.map(({ id }) => id))
  const items = [...refreshed.items]
  const itemIdToFile = new Map(refreshed.itemIdToFile)
  current.items.forEach(({ id }, index) => {
    const existing = ids.has(id) ? undefined : viewer.getItem(id)
    const drafts = existing?.annotations?.filter(({ metadata }) => metadata.kind === 'draft')
    if (existing == null || drafts == null || drafts.length === 0) return
    const kept = drafts.every(({ metadata }) => metadata.kind === 'draft' && metadata.outdated)
      ? existing
      : ({
          ...existing,
          annotations: drafts.map((draft) => ({
            ...draft,
            metadata: { ...draft.metadata, outdated: true },
          })),
          version: getNextItemVersion(existing),
        } as typeof existing)
    items.splice(Math.min(index, items.length), 0, kept)
    const file = current.itemIdToFile.get(id)
    if (file != null) itemIdToFile.set(id, file)
  })
  return items.length === refreshed.items.length ? refreshed : { ...refreshed, items, itemIdToFile }
}

async function withDiffDrafts(
  api: ApiClient,
  drafts: () => ReadonlyMap<string, FileContents>,
  data: LoadedReviewData,
  scope: DiffScope | undefined,
): Promise<LoadedReviewData> {
  if (scope !== 'unstaged' || !data.items.some((item) => drafts().has(item.id))) return data
  const items = await Promise.all(
    data.items.map(async (item) => {
      if (!drafts().has(item.id) || item.type !== 'diff' || item.edit !== true) return item
      const diff = await api.diff({
        scope: 'unstaged',
        path: item.fileDiff.name,
        oldPath: item.fileDiff.prevName,
      })
      const draft = drafts().get(item.id)
      return draft == null ? item : draftDiffItem(item, diff, draft)
    }),
  )
  return { ...data, items }
}

function repositoryFileErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'file-too-large') return 'This file is too large to open in Gitna.'
    if (error.code === 'binary-file') return 'Binary files can’t be opened in the editor.'
    if (error.code === 'unsupported-encoding') {
      return 'This file contains invalid UTF-8 text. Convert it to UTF-8 in another tool before opening it for editing. Gitna has not changed the file.'
    }
    if (error.code === 'file-not-found') {
      return 'This file is no longer available. Refresh Explorer or select another file.'
    }
  }
  return 'Gitna couldn’t read this file. Try again or select another file.'
}

export function getReviewTarget(repository: GitnaRepository): ReviewTarget | null {
  if (repository.repositoryFileComparisonActive && repository.repositoryFileComparison != null) {
    const comparison = repository.repositoryFileComparison
    return {
      comparison,
      key: `file-compare:${comparison.leftPath}:${comparison.rightPath}:${comparison.version}`,
    }
  }
  if (repository.activeReview === 'compare' && repository.compare != null) {
    return {
      key: `compare:${repository.compare.from}:${repository.compare.to}`,
      request: {
        scope: 'compare',
        from: repository.compare.from,
        to: repository.compare.to,
      },
      selectedPath: repository.compareDiff?.path,
      oldPath: repository.compareDiff?.oldPath,
    }
  }
  if (repository.activeReview === 'commit' && repository.commitDiff != null) {
    return {
      key: `commit:${repository.commitDiff.oid}`,
      request: { scope: 'commit', commit: repository.commitDiff.oid },
      selectedPath: repository.commitDiff.path,
      oldPath: repository.commitDiff.oldPath,
    }
  }
  if (repository.repositoryFilePath != null) {
    return {
      filePath: repository.repositoryFilePath,
      key: `file:${repository.repositoryFilePath}`,
      selectedPath: repository.repositoryFilePath,
    }
  }
  if (repository.selection != null) {
    return {
      key: repository.selection.scope,
      request: { scope: repository.selection.scope },
      selectedPath: repository.selection.change.path,
      oldPath: repository.selection.change.oldPath,
    }
  }
  const snapshot = repository.snapshot
  if (snapshot == null || !snapshot.repository) return null
  const scope =
    repository.heldScope ??
    (snapshot.unstaged.length > 0 || snapshot.staged.length === 0 ? 'unstaged' : 'staged')
  return { key: scope, request: { scope } }
}

export function useReviewTarget({
  draftOpen,
  getDrafts,
  hasEditorState,
  loadRepositoryFile,
  repository,
  reviewCacheNamespace,
  setReviewActionError,
  target,
  targetKeyRef,
  updateViewerItems,
  viewerRef,
}: {
  draftOpen: boolean
  getDrafts: () => ReadonlyMap<string, FileContents>
  hasEditorState: (path: string) => boolean
  loadRepositoryFile: (path: string, signal: AbortSignal) => Promise<LoadedReviewData>
  repository: GitnaRepository
  reviewCacheNamespace: string
  setReviewActionError: (value: string | null) => void
  target: ReviewTarget | null
  targetKeyRef: RefObject<string | undefined>
  updateViewerItems: (
    viewer: CodeViewHandle<CommentMetadata, undefined>,
    current: LoadedReviewData,
    refreshed: LoadedReviewData,
    hasDraft: (path: string) => boolean,
  ) => void
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>
}) {
  const [reviewData, setReviewData] = useState<LoadedReviewData | null>(null)
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [failedTargetKey, setFailedTargetKey] = useState<string | null>(null)
  const [fileErrorCode, setFileErrorCode] = useState<string | null>(null)
  const [largeFileWarning, setLargeFileWarning] = useState<{
    path: string
    sizeBytes: number
  } | null>(null)
  const [reviewIdentity, setReviewIdentity] = useState<{
    key: string
    identity: ReviewIdentity
  } | null>(null)
  const [reviewAttempt, setReviewAttempt] = useState(0)
  const reviewDataRef = useRef<LoadedReviewData | null>(null)
  const worktreeComparisonRef = useRef<{ key: string; diff: FileDiff } | null>(null)
  const reviewItemVersionRef = useRef(0)
  const keptDraftItemIdsRef = useRef<ReadonlySet<string>>(new Set())
  const withDraftItems = useCallback(
    (data: LoadedReviewData, sameReview: boolean) => {
      const viewer = viewerRef.current
      const current = reviewDataRef.current
      const kept =
        sameReview && viewer != null && current != null
          ? keepDraftItems(viewer, current, data)
          : data
      keptDraftItemIdsRef.current = new Set(
        kept.items.filter((item) => !data.items.includes(item)).map(({ id }) => id),
      )
      return kept
    },
    [viewerRef],
  )
  useEffect(() => {
    const kept = keptDraftItemIdsRef.current
    if (draftOpen || kept.size === 0) return
    keptDraftItemIdsRef.current = new Set()
    setReviewData(
      (data) => data && { ...data, items: data.items.filter(({ id }) => !kept.has(id)) },
    )
  }, [draftOpen])
  const renderedTargetKeyRef = useRef<string | null>(null)
  const reviewPagingRef = useRef<ReviewPagingState | null>(null)
  const handleNativeReady = useCallback(() => {
    if (targetKeyRef.current !== target?.key) return
    reviewDataRef.current = null
    renderedTargetKeyRef.current = target?.key ?? null
    setReviewData(null)
  }, [target?.key, targetKeyRef])
  const comparisonLeftDraft =
    target?.comparison == null ? undefined : getDrafts().get(target.comparison.leftPath)
  const comparisonRightDraft =
    target?.comparison == null ? undefined : getDrafts().get(target.comparison.rightPath)

  useEffect(() => {
    if (target == null) {
      if (repository.connectionState === 'reconciling' && reviewDataRef.current != null) {
        setErrorMessage(null)
        setLoadState('ready')
        return
      }
      reviewDataRef.current = null
      renderedTargetKeyRef.current = null
      setReviewData(null)
      setErrorMessage(null)
      setLoadState(repository.snapshot?.repository === false ? 'ready' : 'fetching')
      return
    }
    if (target.filePath != null && nativeMediaKind(target.filePath) != null) {
      reviewPagingRef.current = null
      setErrorMessage(null)
      setLoadState('ready')
      return
    }
    let active = true
    const previousLoadedPages =
      reviewPagingRef.current?.targetKey === target.key ? reviewPagingRef.current.loadedPages : 1
    const reviewAbortController = new AbortController()
    reviewPagingRef.current = null
    const refreshingVisibleReview =
      renderedTargetKeyRef.current === target.key &&
      reviewDataRef.current != null &&
      viewerRef.current != null
    const preserveVisibleEditor =
      refreshingVisibleReview &&
      repository.connectionState === 'reconciling' &&
      target.filePath != null &&
      hasEditorState(target.filePath)
    if (!refreshingVisibleReview && reviewDataRef.current == null) {
      renderedTargetKeyRef.current = null
      setReviewData(null)
      setLoadState('fetching')
    }
    setErrorMessage(null)
    setFileErrorCode(null)
    setLargeFileWarning(null)
    const loadWorktreeComparison = async (
      comparison: RepositoryFileComparison,
    ): Promise<LoadedReviewData> => {
      const leftIsImage = rasterImagePattern.test(comparison.leftPath)
      const rightIsImage = rasterImagePattern.test(comparison.rightPath)
      if (leftIsImage !== rightIsImage) {
        throw new Error('Text files and images can’t be compared with each other.')
      }
      const comparisonKey = `${repository.snapshot?.root ?? ''}:${repository.generation}:${comparison.leftPath}:${comparison.rightPath}`
      let diff =
        worktreeComparisonRef.current?.key === comparisonKey
          ? worktreeComparisonRef.current.diff
          : null
      if (diff == null) {
        diff = await repository.api.compareWorktreeFiles(
          comparison.leftPath,
          comparison.rightPath,
          reviewAbortController.signal,
        )
        worktreeComparisonRef.current = { key: comparisonKey, diff }
      }
      if (diff.tooLarge) {
        throw new Error('One of these files is too large to compare in Gitna.')
      }
      if (diff.binary && (diff.before.image == null || diff.after.image == null)) {
        throw new Error('Binary files can’t be compared in Gitna.')
      }
      const leftDraft = getDrafts().get(comparison.leftPath)
      const rightDraft = getDrafts().get(comparison.rightPath)
      return adaptWorktreeComparison(
        diff,
        repository.generation + comparison.version,
        leftDraft == null ? undefined : { ...leftDraft, name: comparison.leftPath },
        rightDraft == null ? undefined : { ...rightDraft, name: comparison.rightPath },
        reviewCacheNamespace,
      )
    }
    const loadReview = async (): Promise<LoadedReviewData> => {
      const request = { ...target.request!, signal: reviewAbortController.signal }
      let page = await repository.api.review(request)
      setReviewIdentity({ key: target.key, identity: page.identity })
      // CodeView ignores new content for matching IDs and versions, even across commits.
      const assembly = createGitnaReviewAccumulator(
        page,
        ++reviewItemVersionRef.current,
        reviewCacheNamespace,
      )
      let result = appendGitnaReviewPage(assembly, page)
      let loadedPages = 1
      while (
        refreshingVisibleReview &&
        page.nextCursor != null &&
        loadedPages < previousLoadedPages
      ) {
        page = await repository.api.review({ ...request, cursor: page.nextCursor })
        result = appendGitnaReviewPage(assembly, page)
        loadedPages++
      }
      reviewPagingRef.current = {
        assembly,
        controller: reviewAbortController,
        cursor: page.nextCursor,
        loadedPages,
        loading: false,
        request,
        targetKey: target.key,
      }
      return withDiffDrafts(repository.api, getDrafts, result.data, request.scope)
    }
    const dataPromise =
      target.comparison == null
        ? target.filePath == null
          ? loadReview()
          : loadRepositoryFile(target.filePath, reviewAbortController.signal)
        : loadWorktreeComparison(target.comparison)
    dataPromise
      .then((data) => {
        if (!active) return
        if (!refreshingVisibleReview && !preserveVisibleEditor) setLoadState('parsing')
        renderedTargetKeyRef.current = target.key
        const preserveLiveEditor = preserveVisibleEditor
        if (!preserveLiveEditor) setReviewData(withDraftItems(data, refreshingVisibleReview))
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        const nextError =
          target.filePath == null
            ? error instanceof Error
              ? error.message
              : String(error)
            : repositoryFileErrorMessage(error)
        if (refreshingVisibleReview || preserveVisibleEditor) {
          setReviewActionError(`Could not refresh review: ${nextError}`)
          setLoadState('ready')
        } else {
          if (
            target.filePath != null &&
            error instanceof ApiError &&
            error.code === 'file-too-large' &&
            Number.isSafeInteger(error.sizeBytes) &&
            error.sizeBytes! > 0
          ) {
            setLargeFileWarning({ path: target.filePath, sizeBytes: error.sizeBytes! })
          }
          setFileErrorCode(
            target.filePath != null && error instanceof ApiError ? (error.code ?? null) : null,
          )
          setFailedTargetKey(target.key)
          setErrorMessage(nextError)
          setLoadState('error')
        }
      })
    return () => {
      active = false
      reviewAbortController.abort()
    }
  }, [
    comparisonLeftDraft?.contents,
    comparisonRightDraft?.contents,
    repository.api,
    repository.generation,
    repository.snapshot?.root,
    reviewAttempt,
    target?.key,
    getDrafts,
    hasEditorState,
    loadRepositoryFile,
    reviewCacheNamespace,
    setReviewActionError,
    viewerRef,
    withDraftItems,
  ])

  useEffect(() => {
    if (reviewData == null) return
    if (reviewData.items.length === 0) {
      viewerRef.current = null
      reviewDataRef.current = reviewData
      return
    }
    const previousData = reviewDataRef.current
    const viewer = viewerRef.current
    if (previousData != null && previousData.items.length > 0 && viewer != null) {
      updateViewerItems(viewer, previousData, reviewData, (path) => getDrafts().has(path))
    }
    reviewDataRef.current = reviewData
  }, [getDrafts, reviewData, updateViewerItems, viewerRef])

  const loadMoreReview = useCallback(
    async (untilPath?: string) => {
      const paging = reviewPagingRef.current
      if (paging == null || paging.cursor == null || paging.loading) return
      paging.loading = true
      try {
        do {
          const page = await repository.api.review({
            ...paging.request,
            cursor: paging.cursor,
          })
          if (reviewPagingRef.current !== paging) return
          const result = appendGitnaReviewPage(paging.assembly, page)
          paging.cursor = page.nextCursor
          paging.loadedPages++
          const data = await withDiffDrafts(
            repository.api,
            getDrafts,
            result.data,
            paging.request.scope,
          )
          if (reviewPagingRef.current !== paging) return
          setReviewData(withDraftItems(data, true))
          if (untilPath == null || result.data.treeSource.pathToItemId.has(untilPath)) return
        } while (paging.cursor != null)
      } catch (error) {
        if (
          reviewPagingRef.current !== paging ||
          paging.controller.signal.aborted ||
          (error instanceof ApiError && error.code === 'review-invalidated')
        ) {
          return
        }
        setReviewActionError(
          `Could not load remaining changes: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        if (reviewPagingRef.current === paging) paging.loading = false
      }
    },
    [getDrafts, repository.api, setReviewActionError, withDraftItems],
  )

  useEffect(() => {
    const selectedPath = target?.selectedPath
    if (
      selectedPath == null ||
      reviewData == null ||
      reviewData.treeSource.pathToItemId.has(selectedPath)
    ) {
      return
    }
    void loadMoreReview(selectedPath)
  }, [loadMoreReview, reviewData, target?.selectedPath])

  return {
    errorMessage,
    failedTargetKey,
    fileErrorCode,
    handleNativeReady,
    largeFileWarning,
    loadMoreReview,
    loadState,
    renderedTargetKeyRef,
    reviewData,
    reviewDataRef,
    reviewIdentity,
    setLargeFileWarning,
    setLoadState,
    setReviewAttempt,
  }
}
