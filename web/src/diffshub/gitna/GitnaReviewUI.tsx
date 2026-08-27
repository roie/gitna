import type { CodeViewLineSelection, DiffIndicators, FileContents } from '@pierre/diffs'
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react'
import { IconX } from '@pierre/icons'
import type { ColorMode } from '@pierre/theming'
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { useThemeController } from '@pierre/theming/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DiffsHubHeader } from '../components/DiffsHubHeader'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { DiffsHubSidebar } from '../components/DiffsHubSidebar'
import { DiffsHubStatusPanel } from '../components/DiffsHubStatusPanel'
import {
  DiffsHubViewer,
  type GitnaEditorActions,
  type GitnaFileAction,
  type GitnaViewerActions,
} from '../components/DiffsHubViewer'
import { ThemeSourceProvider } from '../components/ThemeSourceProvider'
import { docsThemeCatalog, themeController } from '../components/themeController'
import type { CommentMetadata, ViewerLoadState } from '../lib/types'
import { ApiError, type DiffRequest, type ReviewRequest } from '../../lib/api'
import type { FileDiff, WorktreeFile } from '../../lib/types'
import type { DarkThemeName, LightThemeName } from '../lib/themeNames'
import type { LoadedDiffsHubData } from '../lib/diffsHubDataAccumulator'
import { cn } from '../lib/cn'
import { GitnaSourceControl } from './SourceControlWorkflow'
import { Confirm } from './Modal'
import {
  adaptGitnaFile,
  adaptGitnaReview,
  adaptWorktreeFile,
  diffImageAnnotations,
} from './reviewAdapter'
import { useRepository } from './repository'

interface ReviewTarget {
  filePath?: string
  key: string
  oldPath?: string
  request?: ReviewRequest
  selectedPath?: string
}

const rasterImagePattern = /\.(?:gif|jpe?g|png|webp)$/i
const repositoryTabIconResolver = createFileTreeIconResolver('complete')
const repositoryTabIconSprite = getBuiltInSpriteSheet('complete')

function remapWorktreePath(path: string, source: string, destination: string): string {
  if (path === source) return destination
  const sourcePrefix = `${source.replace(/\/$/, '')}/`
  if (!path.startsWith(sourcePrefix)) return path
  return `${destination.replace(/\/$/, '')}/${path.slice(sourcePrefix.length)}`
}

function previousWorktreePath(path: string, source: string, destination: string): string {
  return remapWorktreePath(path, destination, source)
}

function repositoryName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
}

function updateViewerItems(
  viewer: CodeViewHandle<CommentMetadata>,
  current: LoadedDiffsHubData,
  next: LoadedDiffsHubData,
): void {
  const sameOrder =
    current.items.length === next.items.length &&
    current.items.every((item, index) => item.id === next.items[index]?.id)
  if (!sameOrder) {
    for (const item of current.items) viewer.removeItem(item.id)
    viewer.addItems(next.items)
    return
  }
  for (const item of next.items) {
    const existing = viewer.getItem(item.id)
    if (
      existing?.type === 'file' &&
      item.type === 'file' &&
      existing.edit === true &&
      item.edit === true &&
      existing.file.cacheKey === item.file.cacheKey &&
      existing.file.contents === item.file.contents
    ) {
      continue
    }
    viewer.updateItem(item)
  }
}

function imageDiffRequest(target: ReviewTarget | null): DiffRequest | null {
  const path = target?.selectedPath ?? target?.filePath
  if (path == null || !rasterImagePattern.test(path)) return null
  if (target?.filePath != null) return { scope: 'unstaged', path }
  if (target?.request == null) return null
  return { ...target.request, path, oldPath: target.oldPath }
}

function useReviewTarget(): ReviewTarget | null {
  const repository = useRepository()
  if (repository.compare != null) {
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
  if (repository.commitDiff != null) {
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
  if (snapshot == null) return null
  const scope = snapshot.unstaged.length > 0 || snapshot.staged.length === 0 ? 'unstaged' : 'staged'
  return { key: scope, request: { scope } }
}

export function GitnaReviewUI() {
  return (
    <ThemeSourceProvider controller={themeController}>
      <GitnaReviewUIInner />
    </ThemeSourceProvider>
  )
}

function GitnaReviewUIInner() {
  const repository = useRepository()
  const target = useReviewTarget()
  const workerReady = useIsWorkerPoolReadyOrDisabled()
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split')
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>('expanded')
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false)
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('wrap')
  const [showBackgrounds, setShowBackgrounds] = useState(true)
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars')
  const [lineNumbers, setLineNumbers] = useState(true)
  const [themesHydrated, setThemesHydrated] = useState(false)
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [reviewData, setReviewData] = useState<LoadedDiffsHubData | null>(null)
  const [imageDiff, setImageDiff] = useState<FileDiff | null>(null)
  const [reviewAttempt, setReviewAttempt] = useState(0)
  const [reviewActionError, setReviewActionError] = useState<string | null>(null)
  const [worktreeFiles, setWorktreeFiles] = useState<ReadonlyMap<string, WorktreeFile>>(
    () => new Map(),
  )
  const [worktreeDrafts, setWorktreeDrafts] = useState<ReadonlyMap<string, FileContents>>(
    () => new Map(),
  )
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [recentlySavedPath, setRecentlySavedPath] = useState<string | null>(null)
  const [pendingTabClose, setPendingTabClose] = useState<{
    paths: string[]
    dirtyPaths: string[]
  } | null>(null)
  const [pendingRepositoryPath, setPendingRepositoryPath] = useState<string | null>(null)
  const editorRepositoryRootRef = useRef<string | null>(null)
  const reviewDataRef = useRef<LoadedDiffsHubData | null>(null)
  const worktreeFilesRef = useRef(worktreeFiles)
  const worktreeDraftsRef = useRef(worktreeDrafts)
  worktreeFilesRef.current = worktreeFiles
  worktreeDraftsRef.current = worktreeDrafts
  const [pendingFileAction, setPendingFileAction] = useState<{
    action: 'discard' | 'delete'
    path: string
    paths: string[]
  } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null)
  const themeState = useThemeController(themeController)

  useEffect(() => setThemesHydrated(true), [])

  useEffect(() => {
    const root = repository.snapshot?.root
    if (root != null) document.title = `${repositoryName(root)} - Gitna`
  }, [repository.snapshot?.root])

  useEffect(() => {
    const root = repository.snapshot?.root
    if (root == null) return
    if (editorRepositoryRootRef.current != null && editorRepositoryRootRef.current !== root) {
      setWorktreeFiles(new Map())
      setWorktreeDrafts(new Map())
      setRecentlySavedPath(null)
    }
    editorRepositoryRootRef.current = root
  }, [repository.snapshot?.root])

  useEffect(() => {
    if (recentlySavedPath == null) return
    const timer = window.setTimeout(() => setRecentlySavedPath(null), 1500)
    return () => window.clearTimeout(timer)
  }, [recentlySavedPath])

  useEffect(() => {
    const rename = repository.worktreeRename
    if (rename == null) return
    setWorktreeFiles((current) => {
      const next = new Map<string, WorktreeFile>()
      for (const [path, file] of current) {
        const destination = remapWorktreePath(path, rename.source, rename.destination)
        next.set(destination, { ...file, path: destination })
      }
      return next
    })
    setWorktreeDrafts((current) => {
      const next = new Map<string, FileContents>()
      for (const [path, file] of current) {
        const destination = remapWorktreePath(path, rename.source, rename.destination)
        next.set(destination, { ...file, name: destination })
      }
      return next
    })
  }, [repository.worktreeRename?.version])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)')
    const update = (matches: boolean) => {
      setDiffStyle(matches ? 'unified' : 'split')
      if (!matches) setFileTreeOverlayOpen(false)
    }
    const onChange = (event: MediaQueryListEvent) => update(event.matches)
    update(mediaQuery.matches)
    mediaQuery.addEventListener('change', onChange)
    return () => mediaQuery.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setDiffStyle((style) => (style === 'split' ? 'unified' : 'split'))
        return
      }
      if (!event.altKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
        return
      }
      const snapshot = repository.snapshot
      const scope = target?.request?.scope
      if (snapshot == null || (scope !== 'staged' && scope !== 'unstaged')) return
      const changes = scope === 'staged' ? snapshot.staged : snapshot.unstaged
      if (changes.length === 0) return
      event.preventDefault()
      const selectedPath = target?.selectedPath
      const current = changes.findIndex((change) => change.path === selectedPath)
      const offset = event.key === 'ArrowDown' ? 1 : -1
      const next =
        current < 0
          ? offset > 0
            ? 0
            : changes.length - 1
          : (current + offset + changes.length) % changes.length
      repository.select(scope, changes[next]!.path)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [repository, repository.generation, target?.key, target?.selectedPath])

  useEffect(() => {
    if (target == null) {
      reviewDataRef.current = null
      setReviewData(null)
      setErrorMessage(null)
      setLoadState('fetching')
      return
    }
    let active = true
    const refreshingVisibleReview = reviewDataRef.current != null && viewerRef.current != null
    if (!refreshingVisibleReview) {
      setReviewData(null)
      setLoadState('fetching')
    }
    setErrorMessage(null)
    const loadRepositoryFile = async (path: string): Promise<LoadedDiffsHubData> => {
      try {
        const loaded = await repository.api.readWorktreeFile(path)
        const rename = repository.worktreeRename
        const previousPath =
          rename == null ? path : previousWorktreePath(path, rename.source, rename.destination)
        const previousDraft = worktreeDraftsRef.current.get(previousPath)
        const draft =
          worktreeDraftsRef.current.get(path) ??
          (previousDraft == null ? undefined : { ...previousDraft, name: path })
        if (draft == null) {
          setWorktreeFiles((current) => new Map(current).set(path, loaded))
        }
        const baseline =
          draft == null
            ? loaded
            : (worktreeFilesRef.current.get(path) ??
              worktreeFilesRef.current.get(previousPath) ??
              loaded)
        return adaptWorktreeFile({ ...baseline, path }, repository.generation, draft)
      } catch (error) {
        const draft = worktreeDraftsRef.current.get(path)
        const baseline = worktreeFilesRef.current.get(path)
        if (draft != null && baseline != null) {
          return adaptWorktreeFile(baseline, repository.generation, draft)
        }
        if (
          !(error instanceof ApiError) ||
          (error.code !== 'binary-file' && error.code !== 'file-too-large')
        ) {
          throw error
        }
        const diff = await repository.api.diff({ scope: 'unstaged', path })
        return adaptGitnaFile(diff, repository.generation)
      }
    }
    const dataPromise: Promise<LoadedDiffsHubData> =
      target.filePath == null
        ? repository.api.review(target.request!).then(adaptGitnaReview)
        : loadRepositoryFile(target.filePath)
    dataPromise
      .then((data) => {
        if (!active) return
        if (!refreshingVisibleReview) setLoadState('parsing')
        setReviewData(data)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        const nextError = error instanceof Error ? error.message : String(error)
        if (reviewDataRef.current == null) {
          setErrorMessage(nextError)
          setLoadState('error')
        } else {
          setReviewActionError(`Could not refresh review: ${nextError}`)
          setLoadState('ready')
        }
      })
    return () => {
      active = false
    }
  }, [repository.api, repository.generation, reviewAttempt, target?.key])

  useEffect(() => {
    if (reviewData == null) return
    const previousData = reviewDataRef.current
    const viewer = viewerRef.current
    if (previousData != null && viewer != null) updateViewerItems(viewer, previousData, reviewData)
    reviewDataRef.current = reviewData
  }, [reviewData])

  const selectedImageRequest = useMemo(
    () => imageDiffRequest(target),
    [target?.filePath, target?.key, target?.oldPath, target?.selectedPath],
  )

  useEffect(() => {
    setImageDiff(null)
    if (selectedImageRequest == null) return
    let active = true
    repository.api
      .diff(selectedImageRequest)
      .then((diff) => {
        if (active && (diff.before.image != null || diff.after.image != null)) setImageDiff(diff)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [repository.api, repository.generation, selectedImageRequest])

  const colorMode: ColorMode = themesHydrated ? themeState.mode : 'system'
  const lightThemeName = themesHydrated
    ? themeState.lightThemeName
    : docsThemeCatalog.defaultLightThemeName
  const darkThemeName = themesHydrated
    ? themeState.darkThemeName
    : docsThemeCatalog.defaultDarkThemeName
  const setColorMode = useCallback((mode: ColorMode) => themeController.setColorMode(mode), [])
  const setLightThemeName = useCallback(
    (name: LightThemeName) => themeController.setThemeNameForScheme('light', name),
    [],
  )
  const setDarkThemeName = useCallback(
    (name: DarkThemeName) => themeController.setThemeNameForScheme('dark', name),
    [],
  )
  const applyCollapseMode = useCallback(
    (mode: 'expanded' | 'collapsed') => {
      const viewer = viewerRef.current
      if (viewer == null || reviewData == null) return
      for (const sourceItem of reviewData.items) {
        const item = viewer.getItem(sourceItem.id)
        if (item == null || item.collapsed === (mode === 'collapsed')) continue
        item.collapsed = mode === 'collapsed'
        item.version = typeof item.version === 'number' ? item.version + 1 : 1
        viewer.updateItem(item)
      }
    },
    [reviewData],
  )

  const handleToggleCollapseMode = useCallback(() => {
    const next = collapseMode === 'expanded' ? 'collapsed' : 'expanded'
    setCollapseMode(next)
    applyCollapseMode(next)
  }, [applyCollapseMode, collapseMode])

  const handleViewerReady = useCallback(() => {
    if (target?.selectedPath == null || reviewData == null) return
    const itemId = reviewData.treeSource.pathToItemId.get(target.selectedPath)
    if (itemId == null) return
    queueMicrotask(() =>
      viewerRef.current?.scrollTo({
        type: 'item',
        id: itemId,
        align: 'start',
        behavior: 'smooth-auto',
      }),
    )
  }, [reviewData, target?.selectedPath])

  useEffect(() => {
    handleViewerReady()
  }, [handleViewerReady])

  const handleLineLinkChange = useCallback((_selection: CodeViewLineSelection | null) => {}, [])

  const viewerAvailable =
    workerReady && themesHydrated && loadState === 'ready' && reviewData != null

  useEffect(() => {
    if (!viewerAvailable || imageDiff == null || selectedImageRequest == null) return
    const viewer = viewerRef.current
    const itemId = reviewData.treeSource.pathToItemId.get(selectedImageRequest.path)
    const item = itemId == null ? null : viewer?.getItem(itemId)
    if (viewer == null || item?.type !== 'diff') return
    item.annotations = [
      ...(item.annotations ?? []).filter((annotation) => annotation.metadata.kind !== 'image'),
      ...diffImageAnnotations(imageDiff, selectedImageRequest.path),
    ]
    item.version = typeof item.version === 'number' ? item.version + 1 : 1
    viewer.updateItem(item)
    handleViewerReady()
  }, [handleViewerReady, imageDiff, reviewData, selectedImageRequest, viewerAvailable])

  const workingScope =
    target?.request?.scope === 'staged' || target?.request?.scope === 'unstaged'
      ? target.request.scope
      : null
  const gitnaActions: GitnaViewerActions | undefined =
    workingScope == null
      ? undefined
      : {
          scope: workingScope,
          canOpenFile(path) {
            return repository.canOpenRepositoryFile(path)
          },
          kindForPath(path) {
            const list =
              workingScope === 'staged'
                ? repository.snapshot?.staged
                : repository.snapshot?.unstaged
            return list?.find((change) => change.path === path)?.kind
          },
          async loadDiff(path) {
            const list =
              workingScope === 'staged'
                ? repository.snapshot?.staged
                : repository.snapshot?.unstaged
            const change = list?.find((candidate) => candidate.path === path)
            return repository.api.diff({
              scope: workingScope,
              path,
              oldPath: change?.oldPath,
            })
          },
          onFileAction(action: GitnaFileAction, path: string) {
            setReviewActionError(null)
            const list =
              workingScope === 'staged'
                ? repository.snapshot?.staged
                : repository.snapshot?.unstaged
            const change = list?.find((candidate) => candidate.path === path)
            const paths = change?.oldPath ? [change.oldPath, path] : [path]
            if (action === 'discard' || action === 'delete') {
              setPendingFileAction({ action, path, paths })
              return
            }
            void repository
              .mutate({ op: action, paths })
              .catch((error: unknown) =>
                setReviewActionError(error instanceof Error ? error.message : String(error)),
              )
          },
          onOpenFile(path) {
            repository.selectRepositoryFile(path, true)
          },
          onPatch(request) {
            setReviewActionError(null)
            return repository.mutate(request)
          },
          onError: setReviewActionError,
        }

  const dirtyPaths = useMemo(() => new Set(worktreeDrafts.keys()), [worktreeDrafts])
  const closeRepositoryFiles = useCallback(
    (paths: readonly string[]) => {
      const uniquePaths = [...new Set(paths)].filter((path) =>
        repository.repositoryOpenPaths.includes(path),
      )
      if (uniquePaths.length === 0) return
      const dirty = uniquePaths.filter((path) => dirtyPaths.has(path))
      if (dirty.length > 0) {
        setPendingTabClose({ paths: uniquePaths, dirtyPaths: dirty })
        return
      }
      repository.closeRepositoryFiles(uniquePaths)
    },
    [dirtyPaths, repository],
  )
  const handleWorktreeEditChange = useCallback((path: string, file: FileContents) => {
    setRecentlySavedPath((current) => (current === path ? null : current))
    const next = new Map(worktreeDraftsRef.current)
    const baseline = worktreeFilesRef.current.get(path)
    if (baseline != null && baseline.content === file.contents) next.delete(path)
    else next.set(path, file)
    worktreeDraftsRef.current = next
    setWorktreeDrafts(next)
  }, [])
  const saveWorktreeFile = useCallback(
    async (path: string) => {
      const baseline = worktreeFilesRef.current.get(path)
      const draft = worktreeDraftsRef.current.get(path)
      if (baseline == null || draft == null || savingPath != null) return
      const submittedContent = draft.contents
      setSavingPath(path)
      setReviewActionError(null)
      try {
        const saved = await repository.saveWorktreeFile(path, submittedContent, baseline.hash)
        const nextFiles = new Map(worktreeFilesRef.current).set(path, saved)
        worktreeFilesRef.current = nextFiles
        setWorktreeFiles(nextFiles)
        const activeDraft = worktreeDraftsRef.current.get(path)
        if (activeDraft?.contents === submittedContent) {
          const nextDrafts = new Map(worktreeDraftsRef.current)
          nextDrafts.delete(path)
          worktreeDraftsRef.current = nextDrafts
          setWorktreeDrafts(nextDrafts)
          setRecentlySavedPath(path)
        }
      } catch (error) {
        setReviewActionError(error instanceof Error ? error.message : String(error))
      } finally {
        setSavingPath(null)
      }
    },
    [repository, savingPath],
  )
  const gitnaEditorActions: GitnaEditorActions | undefined =
    target?.filePath != null && worktreeFiles.has(target.filePath)
      ? {
          changeScopes(path) {
            const scopes: Array<'unstaged' | 'staged'> = []
            if (repository.snapshot?.unstaged.some((change) => change.path === path)) {
              scopes.push('unstaged')
            }
            if (repository.snapshot?.staged.some((change) => change.path === path)) {
              scopes.push('staged')
            }
            return scopes
          },
          dirtyPaths,
          recentlySavedPath,
          saving: savingPath != null,
          onChange: handleWorktreeEditChange,
          onOpenChange: (scope, path) => repository.select(scope, path),
          onSave: (path) => void saveWorktreeFile(path),
        }
      : undefined

  useEffect(() => {
    const path = target?.filePath
    const item = path == null ? null : viewerRef.current?.getItem(path)
    if (item?.type !== 'file') return
    item.version = typeof item.version === 'number' ? item.version + 1 : 1
    viewerRef.current?.updateItem(item)
  }, [dirtyPaths, recentlySavedPath, savingPath, target?.filePath])

  useEffect(() => {
    const onSave = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      const path = target?.filePath
      if (path == null || !worktreeDraftsRef.current.has(path)) return
      event.preventDefault()
      void saveWorktreeFile(path)
    }
    window.addEventListener('keydown', onSave)
    return () => window.removeEventListener('keydown', onSave)
  }, [dirtyPaths, saveWorktreeFile, target?.filePath])

  return (
    <>
      <ReviewGrid>
        <DiffsHubHeader
          appVersion={repository.snapshot?.appVersion ?? 'dev'}
          className="[grid-area:header]"
          collapseMode={collapseMode}
          colorMode={colorMode}
          darkThemeName={darkThemeName}
          diffIndicators={diffIndicators}
          diffStyle={diffStyle}
          fileTreeAvailable
          fileTreeOverlayOpen={fileTreeOverlayOpen}
          githubTokenActive={false}
          initialUrl={repository.snapshot?.root ?? 'Loading repository…'}
          localRepository
          lightThemeName={lightThemeName}
          lineNumbers={lineNumbers}
          overflow={overflow}
          onClearGitHubToken={() => {}}
          onSaveGitHubToken={() => {}}
          onSwitchRepository={async (path) => {
            if (dirtyPaths.size > 0) {
              setPendingRepositoryPath(path)
              return
            }
            await repository.switchRepository(path)
          }}
          onRevealRepository={async () => {
            setReviewActionError(null)
            try {
              await repository.revealRepository()
            } catch (error) {
              setReviewActionError(error instanceof Error ? error.message : String(error))
            }
          }}
          onToggleCollapseMode={handleToggleCollapseMode}
          onToggleFileTreeOverlay={() => setFileTreeOverlayOpen((open) => !open)}
          setColorMode={setColorMode}
          setDarkThemeName={setDarkThemeName}
          setDiffIndicators={setDiffIndicators}
          setDiffStyle={setDiffStyle}
          setLightThemeName={setLightThemeName}
          setLineNumbers={setLineNumbers}
          setOverflow={setOverflow}
          setShowBackgrounds={setShowBackgrounds}
          showBackgrounds={showBackgrounds}
        />
        {themesHydrated && (
          <DiffsHubSidebar
            className="[grid-area:viewer] md:[grid-area:tree]"
            mobileOverlayOpen={fileTreeOverlayOpen}
            onMobileClose={() => setFileTreeOverlayOpen(false)}
            scrollRef={scrollRef}
          >
            <GitnaSourceControl />
          </DiffsHubSidebar>
        )}
        <div className="flex min-h-0 flex-col [grid-area:viewer]">
          <RepositoryFileTabs dirtyPaths={dirtyPaths} onClose={closeRepositoryFiles} />
          <div className="min-h-0 flex-1">
            {viewerAvailable && reviewData != null && reviewData.items.length > 0 ? (
              <DiffsHubViewer
                className="code-view h-full"
                commentsEnabled={false}
                diffStyle={diffStyle}
                overflow={overflow}
                showBackgrounds={showBackgrounds}
                diffIndicators={diffIndicators}
                lineNumbers={lineNumbers}
                scrollRef={scrollRef}
                themeType={colorMode}
                viewerRef={viewerRef}
                initialItems={reviewData.items}
                gitnaActions={gitnaActions}
                gitnaEditorActions={gitnaEditorActions}
                onCommentDeleted={() => {}}
                onCommentSaved={() => {}}
                onLineLinkChange={handleLineLinkChange}
                onViewerReady={handleViewerReady}
              />
            ) : viewerAvailable && reviewData != null ? (
              <GitnaEmptyState scope={target?.request?.scope} />
            ) : (
              <div className="grid h-full min-h-0 [&>*]:h-full">
                <DiffsHubStatusPanel
                  errorMessage={errorMessage ?? repository.error}
                  localRepository
                  onRetry={() => setReviewAttempt((attempt) => attempt + 1)}
                  state={loadState}
                />
              </div>
            )}
          </div>
        </div>
        {reviewActionError != null && (
          <p
            className="fixed right-3 bottom-3 z-50 max-w-md rounded-md bg-red-600 px-3 py-2 text-xs text-white shadow-lg"
            role="alert"
          >
            {reviewActionError}
          </p>
        )}
      </ReviewGrid>
      {pendingRepositoryPath != null && (
        <Confirm
          title="Discard unsaved changes and switch repository?"
          message={`${dirtyPaths.size} unsaved ${dirtyPaths.size === 1 ? 'file' : 'files'} will be discarded.`}
          confirmLabel="Discard and switch"
          onCancel={() => setPendingRepositoryPath(null)}
          onConfirm={() => {
            const path = pendingRepositoryPath
            setPendingRepositoryPath(null)
            void repository
              .switchRepository(path)
              .then(() => {
                setWorktreeFiles(new Map())
                setWorktreeDrafts(new Map())
              })
              .catch((error: unknown) =>
                setReviewActionError(error instanceof Error ? error.message : String(error)),
              )
          }}
        />
      )}
      {pendingTabClose != null && (
        <Confirm
          title={
            pendingTabClose.dirtyPaths.length === 1
              ? `Discard unsaved changes to ${pendingTabClose.dirtyPaths[0]}?`
              : `Discard unsaved changes in ${pendingTabClose.dirtyPaths.length} files?`
          }
          message={
            pendingTabClose.dirtyPaths.length === 1
              ? 'Your unsaved edits will be lost. The file on disk will not be changed.'
              : 'Your unsaved edits in these tabs will be lost. Files on disk will not be changed.'
          }
          confirmLabel="Discard changes"
          onCancel={() => setPendingTabClose(null)}
          onConfirm={() => {
            const pending = pendingTabClose
            setPendingTabClose(null)
            setWorktreeDrafts((current) => {
              const next = new Map(current)
              for (const path of pending.dirtyPaths) next.delete(path)
              return next
            })
            repository.closeRepositoryFiles(pending.paths)
          }}
        />
      )}
      {pendingFileAction != null && (
        <Confirm
          title={`${pendingFileAction.action === 'delete' ? 'Delete untracked file' : 'Discard changes to'} ${pendingFileAction.path}?`}
          message={
            pendingFileAction.action === 'delete'
              ? 'This permanently deletes the file. This cannot be undone.'
              : 'The file will be restored to its staged version. This cannot be undone.'
          }
          confirmLabel={pendingFileAction.action === 'delete' ? 'Delete file' : 'Discard changes'}
          onCancel={() => setPendingFileAction(null)}
          onConfirm={() => {
            const pending = pendingFileAction
            setPendingFileAction(null)
            void repository
              .mutate({ op: pending.action, paths: pending.paths })
              .catch((error: unknown) =>
                setReviewActionError(error instanceof Error ? error.message : String(error)),
              )
          }}
        />
      )}
    </>
  )
}

function RepositoryTabIconSprite() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host == null) return
    const parsed = new DOMParser().parseFromString(repositoryTabIconSprite, 'text/html')
    const sprites = [...parsed.body.children].filter(
      (element): element is SVGSVGElement => element.localName === 'svg',
    )
    if (sprites.length === 0) return
    for (const sprite of sprites) {
      for (const element of sprite.querySelectorAll('script, foreignObject')) element.remove()
      for (const element of sprite.querySelectorAll('*')) {
        for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
          const attribute = element.attributes.item(index)
          if (attribute?.name.toLowerCase().startsWith('on')) {
            element.removeAttribute(attribute.name)
          }
        }
      }
    }
    host.replaceChildren(...sprites.map((sprite) => document.importNode(sprite, true)))
    return () => host.replaceChildren()
  }, [])
  return <div ref={hostRef} aria-hidden="true" className="absolute size-0 overflow-hidden" />
}

function RepositoryFileTabs({
  dirtyPaths,
  onClose,
}: {
  dirtyPaths: ReadonlySet<string>
  onClose(paths: readonly string[]): void
}) {
  const repository = useRepository()
  const tablistRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{
    anchorRect: DOMRect
    focusTarget: HTMLButtonElement
    index: number
    path: string
  } | null>(null)
  const openPaths = repository.repositoryOpenPaths
  useEffect(() => {
    const activeIndex = openPaths.indexOf(repository.repositoryFilePath ?? '')
    if (activeIndex < 0) return
    queueMicrotask(() =>
      tablistRef.current
        ?.querySelector<HTMLElement>(`[data-tab-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    )
  }, [openPaths, repository.repositoryFilePath])
  if (repository.repositoryFilePath == null || openPaths.length === 0) return null
  const openContextMenu = (
    path: string,
    index: number,
    focusTarget: HTMLButtonElement,
    anchorRect: DOMRect,
  ) => setContextMenu({ anchorRect, focusTarget, index, path })
  const closeFromMenu = (paths: readonly string[]) => {
    setContextMenu(null)
    onClose(paths)
  }
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-muted/20">
      <RepositoryTabIconSprite />
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Open repository files"
        className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain px-2"
        onWheel={(event) => {
          const delta =
            Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
          if (delta === 0) return
          const previousScrollLeft = event.currentTarget.scrollLeft
          event.currentTarget.scrollLeft += delta
          if (event.currentTarget.scrollLeft !== previousScrollLeft) event.preventDefault()
        }}
      >
        {openPaths.map((path, index) => {
          const active = repository.repositoryFilePath === path
          const name = path.split('/').at(-1) ?? path
          const icon = repositoryTabIconResolver.resolveIcon('file-tree-icon-file', path)
          const iconHref = `#${icon.name.replace(/^#/, '')}`
          const iconViewBox =
            icon.viewBox ?? `0 0 ${String(icon.width ?? 16)} ${String(icon.height ?? 16)}`
          return (
            <div
              key={path}
              data-tab-index={index}
              className={cn(
                'group/tab flex h-7 max-w-56 shrink-0 items-center rounded-md text-xs',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                onClose([path])
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                const tab = event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')
                if (tab != null) openContextMenu(path, index, tab, tab.getBoundingClientRect())
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pl-2.5 text-left"
                title={path}
                onClick={() => repository.selectRepositoryFile(path)}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    return
                  event.preventDefault()
                  openContextMenu(
                    path,
                    index,
                    event.currentTarget,
                    event.currentTarget.getBoundingClientRect(),
                  )
                }}
              >
                <svg
                  aria-hidden="true"
                  data-icon-name={icon.name}
                  data-icon-token={icon.token}
                  viewBox={iconViewBox}
                  width={icon.width ?? 16}
                  height={icon.height ?? 16}
                  className="size-4 shrink-0"
                  style={
                    icon.token == null
                      ? undefined
                      : {
                          color: `var(--trees-file-icon-color-${icon.token}, var(--trees-file-icon-color))`,
                        }
                  }
                >
                  <use href={iconHref} />
                </svg>
                <span className="truncate">{name}</span>
                {dirtyPaths.has(path) && (
                  <span
                    aria-label="Unsaved changes"
                    className="size-1.5 shrink-0 rounded-full bg-current"
                  />
                )}
              </button>
              <button
                type="button"
                className="mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background/70 hover:text-foreground group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
                aria-label={`Close ${path}`}
                title={`Close ${path}`}
                onClick={() => onClose([path])}
              >
                <IconX className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      {contextMenu != null && (
        <DropdownMenu
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null)
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              aria-hidden="true"
              tabIndex={-1}
              type="button"
              className="fixed size-px opacity-0"
              style={{ left: contextMenu.anchorRect.left, top: contextMenu.anchorRect.bottom }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={0}
            className="min-w-44"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              const { focusTarget, path } = contextMenu
              queueMicrotask(() => {
                if (repository.repositoryOpenPaths.includes(path) && focusTarget.isConnected) {
                  focusTarget.focus()
                  return
                }
                tablistRef.current
                  ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
                  ?.focus()
              })
            }}
          >
            <DropdownMenuItem onSelect={() => closeFromMenu([contextMenu.path])}>
              Close
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={openPaths.length === 1}
              onSelect={() => closeFromMenu(openPaths.filter((path) => path !== contextMenu.path))}
            >
              Close Others
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={contextMenu.index === 0}
              onSelect={() => closeFromMenu(openPaths.slice(0, contextMenu.index))}
            >
              Close Left
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={contextMenu.index === openPaths.length - 1}
              onSelect={() => closeFromMenu(openPaths.slice(contextMenu.index + 1))}
            >
              Close Right
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={openPaths.every((path) => dirtyPaths.has(path))}
              onSelect={() => closeFromMenu(openPaths.filter((path) => !dirtyPaths.has(path)))}
            >
              Close Clean
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => closeFromMenu(openPaths)}>Close All</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function GitnaEmptyState({ scope }: { scope?: ReviewRequest['scope'] }) {
  const workingTree = scope === 'staged' || scope === 'unstaged'
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 [grid-area:viewer]">
      <section role="status" className="max-w-md text-center">
        <h2 className="text-sm font-medium text-foreground">
          {workingTree ? 'Working tree clean' : 'No differences'}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {workingTree
            ? 'There are no files to review in this scope.'
            : 'The selected references contain no changed files.'}
        </p>
      </section>
    </div>
  )
}

function useIsWorkerPoolReadyOrDisabled(): boolean {
  const workerPool = useWorkerPool()
  const [ready, setReady] = useState(() => workerPool?.isInitialized() ?? true)
  const readyRef = useRef(ready)
  useEffect(
    () =>
      workerPool?.subscribeToStatChanges((stats) => {
        const next = stats.managerState === 'initialized'
        if (next !== readyRef.current) {
          readyRef.current = next
          setReady(next)
        }
      }),
    [workerPool],
  )
  return ready
}

function ReviewGrid({ children }: { children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label="Review"
      className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer'] md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']"
    >
      {children}
    </div>
  )
}
