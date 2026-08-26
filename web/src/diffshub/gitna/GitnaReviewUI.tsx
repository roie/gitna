import type { CodeViewLineSelection, DiffIndicators } from '@pierre/diffs'
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react'
import { IconX } from '@pierre/icons'
import type { ColorMode } from '@pierre/theming'
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { useThemeController } from '@pierre/theming/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import type { CommentMetadata, ViewerLoadState } from '../lib/types'
import type { DiffRequest, ReviewRequest } from '../../lib/api'
import type { FileDiff } from '../../lib/types'
import type { DarkThemeName, LightThemeName } from '../lib/themeNames'
import type { LoadedDiffsHubData } from '../lib/diffsHubDataAccumulator'
import { cn } from '../lib/cn'
import { GitnaSourceControl } from './SourceControlWorkflow'
import { Confirm } from './Modal'
import { adaptGitnaFile, adaptGitnaReview, diffImageAnnotations } from './reviewAdapter'
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
  if (repository.selection != null) {
    return {
      key: repository.selection.scope,
      request: { scope: repository.selection.scope },
      selectedPath: repository.selection.change.path,
      oldPath: repository.selection.change.oldPath,
    }
  }
  if (repository.repositoryFilePath != null) {
    return {
      filePath: repository.repositoryFilePath,
      key: `file:${repository.repositoryFilePath}`,
      selectedPath: repository.repositoryFilePath,
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
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('scroll')
  const [showBackgrounds, setShowBackgrounds] = useState(true)
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars')
  const [lineNumbers, setLineNumbers] = useState(true)
  const [themesHydrated, setThemesHydrated] = useState(false)
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [reviewData, setReviewData] = useState<LoadedDiffsHubData | null>(null)
  const [imageDiff, setImageDiff] = useState<FileDiff | null>(null)
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
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
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
        target?.request?.scope === 'staged' || target?.request?.scope === 'unstaged'
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
    if (target == null) {
      setReviewData(null)
      setErrorMessage(null)
      setLoadState('fetching')
      return
    }
    let active = true
    setReviewData(null)
    setLoadState('fetching')
    setErrorMessage(null)
    const dataPromise: Promise<LoadedDiffsHubData> =
      target.filePath == null
        ? repository.api.review(target.request!).then(adaptGitnaReview)
        : repository.api
            .diff({ scope: 'unstaged', path: target.filePath })
            .then((diff) => adaptGitnaFile(diff, repository.generation))
    dataPromise
      .then((data) => {
        if (!active) return
        setLoadState('parsing')
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
          onSwitchRepository={(path) => repository.switchRepository(path)}
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
          <RepositoryFileTabs />
          <div className="min-h-0 flex-1">
            {viewerAvailable && reviewData != null && reviewData.items.length > 0 ? (
              <DiffsHubViewer
                key={reviewKey}
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

function RepositoryFileTabs() {
  const repository = useRepository()
  if (repository.repositoryFilePath == null || repository.repositoryOpenPaths.length === 0)
    return null
  return (
    <div
      role="tablist"
      aria-label="Open repository files"
      className="no-scrollbar flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/20 px-2"
    >
      <RepositoryTabIconSprite />
      {repository.repositoryOpenPaths.map((path) => {
        const active = repository.repositoryFilePath === path
        const name = path.split('/').at(-1) ?? path
        const icon = repositoryTabIconResolver.resolveIcon('file-tree-icon-file', path)
        const iconHref = `#${icon.name.replace(/^#/, '')}`
        const iconViewBox =
          icon.viewBox ?? `0 0 ${String(icon.width ?? 16)} ${String(icon.height ?? 16)}`
        return (
          <div
            key={path}
            className={cn(
              'group/tab flex h-7 max-w-56 shrink-0 items-center rounded-md text-xs',
              active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pl-2.5 text-left"
              title={path}
              onClick={() => repository.selectRepositoryFile(path)}
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
            </button>
            <button
              type="button"
              className="mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background/70 hover:text-foreground group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
              aria-label={`Close ${path}`}
              title={`Close ${path}`}
              onClick={() => repository.closeRepositoryFile(path)}
            >
              <IconX className="size-3" />
            </button>
          </div>
        )
      })}
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
