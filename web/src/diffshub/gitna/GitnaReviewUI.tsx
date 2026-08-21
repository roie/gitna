import type { CodeViewLineSelection, DiffIndicators } from '@pierre/diffs'
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react'
import type { ColorMode } from '@pierre/theming'
import { useThemeController } from '@pierre/theming/react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { DiffsHubHeader } from '../components/DiffsHubHeader'
import { DiffsHubSidebar } from '../components/DiffsHubSidebar'
import { DiffsHubStatusPanel } from '../components/DiffsHubStatusPanel'
import {
  DiffsHubViewer,
  type GitnaFileAction,
  type GitnaViewerActions,
} from '../components/DiffsHubViewer'
import { ThemeSourceProvider } from '../components/ThemeSourceProvider'
import { docsThemeCatalog, themeController } from '../components/themeController'
import type {
  CommentMetadata,
  ViewerLoadState,
} from '../lib/types'
import type { ReviewRequest } from '../../lib/api'
import type { DarkThemeName, LightThemeName } from '../lib/themeNames'
import type { LoadedDiffsHubData } from '../lib/diffsHubDataAccumulator'
import { GitnaSourceControl } from './SourceControlWorkflow'
import { Confirm } from './Modal'
import { adaptGitnaReview } from './reviewAdapter'
import { useRepository } from './repository'

interface ReviewTarget {
  key: string
  request: ReviewRequest
  selectedPath?: string
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
    }
  }
  if (repository.commitDiff != null) {
    return {
      key: `commit:${repository.commitDiff.oid}`,
      request: { scope: 'commit', commit: repository.commitDiff.oid },
      selectedPath: repository.commitDiff.path,
    }
  }
  if (repository.selection != null) {
    return {
      key: repository.selection.scope,
      request: { scope: repository.selection.scope },
      selectedPath: repository.selection.change.path,
    }
  }
  const snapshot = repository.snapshot
  if (snapshot == null) return null
  const scope =
    snapshot.unstaged.length > 0 || snapshot.staged.length === 0
      ? 'unstaged'
      : 'staged'
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
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>(
    'expanded',
  )
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false)
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('scroll')
  const [showBackgrounds, setShowBackgrounds] = useState(true)
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars')
  const [lineNumbers, setLineNumbers] = useState(true)
  const [themesHydrated, setThemesHydrated] = useState(false)
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [reviewData, setReviewData] = useState<LoadedDiffsHubData | null>(null)
  const [reviewAttempt, setReviewAttempt] = useState(0)
  const [reviewKey, setReviewKey] = useState(0)
  const [reviewActionError, setReviewActionError] = useState<string | null>(null)
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
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === 'l'
      ) {
        event.preventDefault()
        setDiffStyle((style) => (style === 'split' ? 'unified' : 'split'))
        return
      }
      if (!event.altKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
        return
      }
      const snapshot = repository.snapshot
      if (snapshot == null) return
      const scope =
        target?.request.scope === 'staged' || target?.request.scope === 'unstaged'
          ? target.request.scope
          : snapshot.unstaged.length > 0
            ? 'unstaged'
            : 'staged'
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
    if (target == null) return
    let active = true
    setLoadState('fetching')
    setErrorMessage(null)
    repository.api
      .review(target.request)
      .then((review) => {
        if (!active) return
        setLoadState('parsing')
        const data = adaptGitnaReview(review)
        if (!active) return
        setReviewData(data)
        setReviewKey((key) => key + 1)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        setErrorMessage(error instanceof Error ? error.message : String(error))
        setLoadState('error')
      })
    return () => {
      active = false
    }
  }, [repository.api, repository.generation, reviewAttempt, target?.key])

  const colorMode: ColorMode = themesHydrated ? themeState.mode : 'system'
  const lightThemeName = themesHydrated
    ? themeState.lightThemeName
    : docsThemeCatalog.defaultLightThemeName
  const darkThemeName = themesHydrated
    ? themeState.darkThemeName
    : docsThemeCatalog.defaultDarkThemeName
  const setColorMode = useCallback(
    (mode: ColorMode) => themeController.setColorMode(mode),
    [],
  )
  const setLightThemeName = useCallback(
    (name: LightThemeName) =>
      themeController.setThemeNameForScheme('light', name),
    [],
  )
  const setDarkThemeName = useCallback(
    (name: DarkThemeName) =>
      themeController.setThemeNameForScheme('dark', name),
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

  const handleLineLinkChange = useCallback(
    (_selection: CodeViewLineSelection | null) => {},
    [],
  )

  const viewerAvailable =
    workerReady &&
    themesHydrated &&
    loadState === 'ready' &&
    reviewData != null

  const workingScope =
    target?.request.scope === 'staged' || target?.request.scope === 'unstaged'
      ? target.request.scope
      : null
  const gitnaActions: GitnaViewerActions | undefined =
    workingScope == null
      ? undefined
      : {
          scope: workingScope,
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
                setReviewActionError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
          },
          onPatch(request) {
            setReviewActionError(null)
            return repository.mutate(request)
          },
          onError: setReviewActionError,
        }

  return (
    <>
    <ReviewGrid>
      <DiffsHubHeader
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
      {viewerAvailable && reviewData != null && reviewData.items.length > 0 ? (
          <DiffsHubViewer
            key={reviewKey}
            className="code-view [grid-area:viewer]"
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
            onCommentDeleted={() => {}}
            onCommentSaved={() => {}}
            onLineLinkChange={handleLineLinkChange}
            onViewerReady={handleViewerReady}
          />
      ) : viewerAvailable && reviewData != null ? (
        <GitnaEmptyState scope={target?.request.scope} />
      ) : (
        <div className="grid min-h-0 [grid-area:viewer] [&>*]:h-full">
          <DiffsHubStatusPanel
            errorMessage={errorMessage ?? repository.error}
            localRepository
            onRetry={() => setReviewAttempt((attempt) => attempt + 1)}
            state={loadState}
          />
        </div>
      )}
      {reviewActionError != null && (
        <p className="fixed right-3 bottom-3 z-50 max-w-md rounded-md bg-red-600 px-3 py-2 text-xs text-white shadow-lg" role="alert">
          {reviewActionError}
        </p>
      )}
    </ReviewGrid>
    {pendingFileAction != null && (
      <Confirm
        title={`${pendingFileAction.action === 'delete' ? 'Delete' : 'Discard changes in'} ${pendingFileAction.path}?`}
        message={`${repository.snapshot?.root ?? 'Repository'} · ${repository.snapshot?.headBranch ?? 'detached'}. This action cannot be undone by Gitna.`}
        confirmLabel={pendingFileAction.action === 'delete' ? 'Delete' : 'Discard'}
        onCancel={() => setPendingFileAction(null)}
        onConfirm={() => {
          const pending = pendingFileAction
          setPendingFileAction(null)
          void repository
            .mutate({ op: pending.action, paths: pending.paths })
            .catch((error: unknown) =>
              setReviewActionError(
                error instanceof Error ? error.message : String(error),
              ),
            )
        }}
      />
    )}
    </>
  )
}

function GitnaEmptyState({ scope }: { scope?: ReviewRequest['scope'] }) {
  const workingTree = scope === 'staged' || scope === 'unstaged'
  return (
    <div className="flex min-h-0 items-center justify-center bg-background p-6 [grid-area:viewer]">
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
