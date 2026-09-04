import type { CodeViewLineSelection, DiffIndicators, FileContents } from '@pierre/diffs'
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react'
import {
  IconBranch,
  IconCheck,
  IconDiffSplit,
  IconFolder,
  IconFolderOpen,
  IconHome,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSidebar,
  IconThemes,
  IconX,
} from '@pierre/icons'
import type { ColorMode } from '@pierre/theming'
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { useThemeController } from '@pierre/theming/react'
import { type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  type GitnaComparisonActions,
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
import { GitnaCommandPalette, type GitnaPaletteCommand } from './GitnaCommandPalette'
import { FolderLoadingScreen, folderDisplayName } from './FolderLoadingScreen'
import { GitnaHome } from './GitnaHome'
import { GitnaSourceControl } from './SourceControlWorkflow'
import { Confirm } from './Modal'
import {
  adaptGitnaFile,
  appendGitnaReviewPage,
  createGitnaReviewAccumulator,
  adaptWorktreeComparison,
  adaptWorktreeFile,
  diffImageAnnotations,
  type GitnaReviewAccumulator,
} from './reviewAdapter'
import { startupTraceEnabled, useRepository, type RepositoryFileComparison } from './repository'

interface ReviewTarget {
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
  return folderDisplayName(root)
}

const switchStartupStorageKey = 'gitna:switch-start'

function markDestinationStartup(): void {
  if (!startupTraceEnabled()) return
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  if (navigation != null) {
    performance.mark('gitna:destination-response', { startTime: navigation.responseStart })
  }
  performance.mark('gitna:mount')
  let raw: string | null
  try {
    raw = sessionStorage.getItem(switchStartupStorageKey)
    sessionStorage.removeItem(switchStartupStorageKey)
  } catch {
    return
  }
  if (raw == null) return
  try {
    const marker = JSON.parse(raw) as { startedAt?: unknown; version?: unknown }
    if (
      marker.version === 1 &&
      typeof marker.startedAt === 'number' &&
      Date.now() - marker.startedAt >= 0 &&
      Date.now() - marker.startedAt < 5 * 60_000
    ) {
      performance.mark('gitna:switch-destination', {
        detail: { elapsedMs: Date.now() - marker.startedAt },
      })
    }
  } catch {
    // A malformed local marker is ignored and removed above.
  }
}

function gitnaLogoDataUrl(dark: boolean): string | null {
  const filename = dark ? 'gitna-logo-dark.png' : 'gitna-logo-light.png'
  const source = [...window.document.images].find((image) => image.src.endsWith(`/${filename}`))
  if (source == null || !source.complete || source.naturalWidth === 0) return null
  const canvas = window.document.createElement('canvas')
  canvas.width = source.naturalWidth
  canvas.height = source.naturalHeight
  canvas.getContext('2d')?.drawImage(source, 0, 0)
  return canvas.toDataURL('image/png')
}

function renderFolderLoadingDocument(newTab: Window, path: string, colorMode: ColorMode): void {
  const document = newTab.document
  const folderName = repositoryName(path)
  const assetUrl = (name: string) => new URL(`./${name}`, window.location.href).href
  const dark =
    colorMode === 'dark' ||
    (colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const logoUrl =
    gitnaLogoDataUrl(dark) ?? assetUrl(dark ? 'gitna-logo-dark.png' : 'gitna-logo-light.png')

  document.documentElement.lang = 'en'
  document.documentElement.dataset.colorMode = colorMode

  const title = document.createElement('title')
  title.textContent = `Opening ${folderName} - Gitna`
  const viewport = document.createElement('meta')
  viewport.name = 'viewport'
  viewport.content = 'width=device-width, initial-scale=1'
  const favicon = document.createElement('link')
  favicon.rel = 'icon'
  favicon.type = 'image/png'
  favicon.href = assetUrl(dark ? 'favicon-dark.png' : 'favicon-light.png')
  const style = document.createElement('style')
  style.textContent = `
    :root { color-scheme: light; --bg: #ffffff; --fg: #171717; --muted: #737373; --ring: #d4d4d4; }
    :root[data-color-mode="dark"] { color-scheme: dark; --bg: #0f0f0f; --fg: #f5f5f5; --muted: #a3a3a3; --ring: #404040; }
    @media (prefers-color-scheme: dark) {
      :root[data-color-mode="system"] { color-scheme: dark; --bg: #0f0f0f; --fg: #f5f5f5; --muted: #a3a3a3; --ring: #404040; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { display: flex; max-width: calc(100vw - 3rem); flex-direction: column; align-items: center; text-align: center; }
    .brand { display: flex; align-items: center; gap: .625rem; font-size: 1rem; font-weight: 600; }
    .brand img { width: 40px; height: 40px; }
    h1 { max-width: 28rem; margin: 1.25rem 0 0; overflow: hidden; text-overflow: ellipsis; font-size: 1.125rem; font-weight: 600; white-space: nowrap; }
    p { margin: .375rem 0 0; color: var(--muted); font-size: .875rem; }
    .spinner { width: 18px; height: 18px; margin-top: 1.25rem; border: 2px solid var(--ring); border-top-color: var(--fg); border-radius: 999px; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  `
  document.head.replaceChildren(title, viewport, favicon, style)

  const main = document.createElement('main')
  const brand = document.createElement('div')
  brand.className = 'brand'
  const logo = document.createElement('img')
  logo.src = logoUrl
  logo.alt = ''
  const brandName = document.createElement('span')
  brandName.textContent = 'Gitna'
  brand.replaceChildren(logo, brandName)
  const heading = document.createElement('h1')
  heading.textContent = `Opening ${folderName}`
  const status = document.createElement('p')
  status.role = 'status'
  status.textContent = 'Preparing your folder…'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  spinner.setAttribute('aria-hidden', 'true')
  main.replaceChildren(brand, heading, status, spinner)
  document.body.replaceChildren(main)
}

function updateViewerItems(
  viewer: CodeViewHandle<CommentMetadata>,
  current: LoadedDiffsHubData,
  next: LoadedDiffsHubData,
): void {
  const sharedItemsMatch = current.items.every((item, index) => {
    const nextItem = next.items[index]
    return (
      item.id === nextItem?.id && item.type === nextItem.type && item.version === nextItem.version
    )
  })
  if (next.items.length > current.items.length && sharedItemsMatch) {
    viewer.getInstance()?.setItems(next.items)
    return
  }
  const sameItemKinds = next.items.length === current.items.length && sharedItemsMatch
  if (!sameItemKinds) {
    viewer.getInstance()?.setItems(next.items)
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

function imageDiffRequest(target: ReviewTarget | null, repository: boolean): DiffRequest | null {
  const path = target?.selectedPath ?? target?.filePath
  if (path == null || !rasterImagePattern.test(path)) return null
  if (target?.filePath != null) return repository ? { scope: 'unstaged', path } : null
  if (target?.request == null) return null
  return { ...target.request, path, oldPath: target.oldPath }
}

function repositoryFileErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'file-too-large') return 'This file is too large to open in Gitna.'
    if (error.code === 'binary-file') return 'Binary files can’t be opened in the editor.'
    if (error.code === 'file-not-found') {
      return 'This file is no longer available. Refresh Explorer or select another file.'
    }
  }
  return 'Gitna couldn’t read this file. Try again or select another file.'
}

function useReviewTarget(): ReviewTarget | null {
  const repository = useRepository()
  if (repository.repositoryFileComparisonActive && repository.repositoryFileComparison != null) {
    const comparison = repository.repositoryFileComparison
    return {
      comparison,
      key: `file-compare:${comparison.leftPath}:${comparison.rightPath}:${comparison.version}`,
    }
  }
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
  if (snapshot == null || !snapshot.repository) return null
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
  const [mobileViewport, setMobileViewport] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [recentFilePaths, setRecentFilePaths] = useState<readonly string[]>([])
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
  const [homeOpen, setHomeOpen] = useState(false)
  const [homeSwitchError, setHomeSwitchError] = useState<string | null>(null)
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
  const [pendingFolderSwitch, setPendingFolderSwitch] = useState<{
    focusTarget: HTMLElement | null
    path: string
    returnHome: boolean
  } | null>(null)
  const [folderSwitchTransition, setFolderSwitchTransition] = useState<{
    id: number
    path: string
  } | null>(null)
  const folderSwitchOperationRef = useRef<{
    controller: AbortController
    id: number
    previousFocus: HTMLElement | null
    previousTitle: string
  } | null>(null)
  const nextFolderSwitchIDRef = useRef(0)
  const editorRepositoryRootRef = useRef<string | null>(null)
  const reviewDataRef = useRef<LoadedDiffsHubData | null>(null)
  const renderedTargetKeyRef = useRef<string | null>(null)
  const reviewPagingRef = useRef<ReviewPagingState | null>(null)
  const worktreeComparisonRef = useRef<{ key: string; diff: FileDiff } | null>(null)
  // CodeView owns the imperative header root, so its save callback may outlive a React render.
  const savingPathRef = useRef<string | null>(null)
  const worktreeFilesRef = useRef(worktreeFiles)
  const worktreeDraftsRef = useRef(worktreeDrafts)
  const allowFolderNavigationRef = useRef(false)
  worktreeFilesRef.current = worktreeFiles
  worktreeDraftsRef.current = worktreeDrafts
  const [pendingFileAction, setPendingFileAction] = useState<{
    action: 'discard' | 'delete'
    path: string
    paths: string[]
  } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const reviewRootRef = useRef<HTMLDivElement>(null)
  const homeButtonRef = useRef<HTMLButtonElement>(null)
  const restoreHomeFocusRef = useRef(false)
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null)
  const themeState = useThemeController(themeController)

  useEffect(() => {
    setThemesHydrated(true)
    markDestinationStartup()
    return () => folderSwitchOperationRef.current?.controller.abort()
  }, [])

  useEffect(() => {
    const root = repository.snapshot?.root
    if (root != null) document.title = `${repositoryName(root)} - Gitna`
  }, [repository.snapshot?.root])

  useEffect(() => {
    const path = repository.repositoryFilePath
    if (path == null) return
    setRecentFilePaths((current) =>
      [...current.filter((candidate) => candidate !== path), path].slice(-20),
    )
  }, [repository.repositoryFilePath])

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
      setMobileViewport(matches)
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
    const openPalette = (event: KeyboardEvent) => {
      if (
        homeOpen ||
        event.key.toLocaleLowerCase() !== 'k' ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      ) {
        return
      }
      event.preventDefault()
      if (event.repeat) return
      setCommandPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', openPalette)
    return () => window.removeEventListener('keydown', openPalette)
  }, [homeOpen])

  const comparisonLeftDraft =
    target?.comparison == null ? undefined : worktreeDrafts.get(target.comparison.leftPath)
  const comparisonRightDraft =
    target?.comparison == null ? undefined : worktreeDrafts.get(target.comparison.rightPath)

  useEffect(() => {
    if (target == null) {
      reviewDataRef.current = null
      renderedTargetKeyRef.current = null
      setReviewData(null)
      setErrorMessage(null)
      setLoadState(repository.snapshot?.repository === false ? 'ready' : 'fetching')
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
    if (!refreshingVisibleReview) {
      renderedTargetKeyRef.current = null
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
        const unavailableTextFile =
          error instanceof ApiError &&
          (error.code === 'binary-file' || error.code === 'file-too-large')
        if (!unavailableTextFile) throw error
        if (!repository.snapshot?.repository) {
          if (!rasterImagePattern.test(path)) throw error
          const diff = await repository.api.compareWorktreeFiles(
            path,
            path,
            reviewAbortController.signal,
          )
          if (diff.tooLarge || diff.after.image == null) throw error
          return adaptGitnaFile(diff, repository.generation)
        }
        const diff = await repository.api.diff({ scope: 'unstaged', path })
        return adaptGitnaFile(diff, repository.generation)
      }
    }
    const loadWorktreeComparison = async (
      comparison: RepositoryFileComparison,
    ): Promise<LoadedDiffsHubData> => {
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
      const leftDraft = worktreeDraftsRef.current.get(comparison.leftPath)
      const rightDraft = worktreeDraftsRef.current.get(comparison.rightPath)
      return adaptWorktreeComparison(
        diff,
        repository.generation + comparison.version,
        leftDraft == null ? undefined : { ...leftDraft, name: comparison.leftPath },
        rightDraft == null ? undefined : { ...rightDraft, name: comparison.rightPath },
      )
    }
    const loadReview = async (): Promise<LoadedDiffsHubData> => {
      const request = { ...target.request!, signal: reviewAbortController.signal }
      let page = await repository.api.review(request)
      const assembly = createGitnaReviewAccumulator(page)
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
      return result.data
    }
    const dataPromise =
      target.comparison == null
        ? target.filePath == null
          ? loadReview()
          : loadRepositoryFile(target.filePath)
        : loadWorktreeComparison(target.comparison)
    dataPromise
      .then((data) => {
        if (!active) return
        if (!refreshingVisibleReview) setLoadState('parsing')
        renderedTargetKeyRef.current = target.key
        setReviewData(data)
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
        if (refreshingVisibleReview) {
          setReviewActionError(`Could not refresh review: ${nextError}`)
          setLoadState('ready')
        } else {
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
      updateViewerItems(viewer, previousData, reviewData)
    }
    reviewDataRef.current = reviewData
  }, [reviewData])

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
          setReviewData(result.data)
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
    [repository.api],
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

  const handleReviewScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (scroller == null) return
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (remaining <= scroller.clientHeight) void loadMoreReview()
  }, [loadMoreReview])

  const selectedImageRequest = useMemo(
    () => imageDiffRequest(target, repository.snapshot?.repository === true),
    [
      repository.snapshot?.repository,
      target?.filePath,
      target?.key,
      target?.oldPath,
      target?.selectedPath,
    ],
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
            void repository
              .openRepositoryFile(path, true)
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

  const graphFile = repository.commitDiff
  const graphPath = graphFile?.path
  const gitnaOpenFileAction =
    graphFile == null || graphPath == null || graphFile.kind === 'deleted'
      ? undefined
      : {
          ariaLabel: (path: string) => `Open ${path} in Repository`,
          canOpenFile: (path: string) => path === graphPath && !path.endsWith('/'),
          onOpenFile: (path: string) => {
            void repository
              .openRepositoryFile(path, true)
              .catch((error: unknown) =>
                setReviewActionError(error instanceof Error ? error.message : String(error)),
              )
          },
        }

  const dirtyPaths = useMemo(() => new Set(worktreeDrafts.keys()), [worktreeDrafts])
  useEffect(() => {
    if (dirtyPaths.size === 0) return
    const protectDrafts = (event: BeforeUnloadEvent) => {
      if (!allowFolderNavigationRef.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', protectDrafts)
    return () => window.removeEventListener('beforeunload', protectDrafts)
  }, [dirtyPaths.size])
  const gitnaComparisonActions: GitnaComparisonActions | undefined =
    target?.comparison == null
      ? undefined
      : {
          leftDirty: dirtyPaths.has(target.comparison.leftPath),
          leftPath: target.comparison.leftPath,
          rightDirty: dirtyPaths.has(target.comparison.rightPath),
          rightPath: target.comparison.rightPath,
          onSwap: () => repository.swapRepositoryFileComparison(),
        }
  const openHome = useCallback(() => {
    setCommandPaletteOpen(false)
    setHomeSwitchError(null)
    setHomeOpen(true)
  }, [])
  const closeHome = useCallback(() => {
    restoreHomeFocusRef.current = true
    setHomeOpen(false)
  }, [])
  useEffect(() => {
    if (homeOpen || !restoreHomeFocusRef.current) return
    restoreHomeFocusRef.current = false
    homeButtonRef.current?.focus()
  }, [homeOpen])
  const performFolderSwitch = useCallback(
    async (path: string, returnHome: boolean, restoreFocus?: HTMLElement | null) => {
      if (returnHome) setHomeSwitchError(null)
      const previousOperation = folderSwitchOperationRef.current
      previousOperation?.controller.abort()
      const id = ++nextFolderSwitchIDRef.current
      const controller = new AbortController()
      const previousTitle = previousOperation?.previousTitle ?? document.title
      const previousFocus =
        restoreFocus ??
        previousOperation?.previousFocus ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      folderSwitchOperationRef.current = { controller, id, previousFocus, previousTitle }
      setFolderSwitchTransition({ id, path })
      document.title = `Opening ${folderDisplayName(path)} - Gitna`
      const traceStartup = startupTraceEnabled()
      if (traceStartup) {
        try {
          sessionStorage.setItem(
            switchStartupStorageKey,
            JSON.stringify({ version: 1, startedAt: Date.now() }),
          )
        } catch {
          // Startup diagnostics are optional and never block navigation.
        }
      }

      // Let React commit the transition before starting potentially expensive
      // local discovery. This gives immediate, truthful feedback even on a
      // cold or deeply nested folder.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (folderSwitchOperationRef.current?.id !== id) return
      try {
        const result = await repository.openFolder(path, controller.signal)
        if (folderSwitchOperationRef.current?.id !== id) return
        const target = new URL(result.href, window.location.href)
        if (target.origin !== window.location.origin) {
          throw new Error('folder route must remain on the current Gitna origin')
        }
        if (traceStartup) target.searchParams.set('trace-startup', '1')
        allowFolderNavigationRef.current = true
        window.location.assign(target.href)
      } catch (error) {
        if (folderSwitchOperationRef.current?.id !== id) return
        allowFolderNavigationRef.current = false
        folderSwitchOperationRef.current = null
        setFolderSwitchTransition(null)
        if (traceStartup) {
          try {
            sessionStorage.removeItem(switchStartupStorageKey)
          } catch {
            // Startup diagnostics are optional and never block recovery.
          }
        }
        document.title = previousTitle
        requestAnimationFrame(() => previousFocus?.focus())
        const detail = error instanceof Error ? error.message : String(error)
        const message = `Could not open ${folderDisplayName(path)}: ${detail}`
        if (!returnHome) {
          setReviewActionError(message)
          throw new Error(message, { cause: error })
        }
        setHomeSwitchError(message)
      }
    },
    [repository],
  )
  const openFolderInNewTab = useCallback(
    (path: string): Promise<void> => {
      const newTab = window.open('about:blank', '_blank')
      if (newTab == null) {
        return Promise.reject(new Error('Allow pop-ups to open this folder in a new tab.'))
      }
      renderFolderLoadingDocument(newTab, path, colorMode)
      return repository
        .openFolder(path)
        .then((result) => {
          const target = new URL(result.href, window.location.href)
          if (target.origin !== window.location.origin) {
            throw new Error('folder route must remain on the current Gitna origin')
          }
          if (!newTab.closed) newTab.location.replace(target.href)
        })
        .catch((error: unknown) => {
          if (!newTab.closed) newTab.close()
          throw error
        })
    },
    [colorMode, repository],
  )
  const requestFolderSwitch = useCallback(
    async (path: string, returnHome: boolean) => {
      if (path === repository.snapshot?.root) {
        if (returnHome) closeHome()
        return
      }
      if (dirtyPaths.size > 0) {
        setPendingFolderSwitch({
          focusTarget:
            document.activeElement instanceof HTMLElement ? document.activeElement : null,
          path,
          returnHome,
        })
        return
      }
      await performFolderSwitch(path, returnHome)
    },
    [closeHome, dirtyPaths.size, performFolderSwitch, repository.snapshot?.root],
  )
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
      if (baseline == null || draft == null || savingPathRef.current != null) return
      const submittedContent = draft.contents
      savingPathRef.current = path
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
        savingPathRef.current = null
        setSavingPath(null)
      }
    },
    [repository],
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

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia('(max-width: 767px)').matches) {
      setFileTreeOverlayOpen((visible) => !visible)
      return
    }
    setSidebarVisible((visible) => !visible)
  }, [])

  const paletteFileHistory = useMemo(
    () => [
      ...recentFilePaths.filter((path) => !repository.repositoryOpenPaths.includes(path)),
      ...repository.repositoryOpenPaths,
    ],
    [recentFilePaths, repository.repositoryOpenPaths],
  )

  const searchOrdinaryPalette = useCallback(
    (query: string) => void repository.searchOrdinaryFiles(query, paletteFileHistory),
    [paletteFileHistory, repository],
  )

  const paletteCommands = useMemo<GitnaPaletteCommand[]>(() => {
    const commands: GitnaPaletteCommand[] = [
      {
        id: 'open-folder',
        icon: <IconFolderOpen />,
        label: 'Open Folder',
        description: 'Enter an absolute local folder path',
        keywords: 'switch location path',
        run() {
          openHome()
          window.setTimeout(
            () => document.querySelector<HTMLInputElement>('[aria-label="Folder path"]')?.focus(),
            0,
          )
        },
      },
      {
        id: 'home',
        icon: <IconHome />,
        label: 'Gitna Home',
        description: 'Open folders and recent history',
        keywords: 'welcome recent',
        run: openHome,
      },
      {
        id: 'refresh',
        icon: <IconRefresh />,
        label: 'Refresh',
        description: 'Refresh the current folder',
        keywords: 'reload repository explorer graph',
        run: () => repository.refreshCurrentFolder(),
      },
      {
        id: 'toggle-sidebar',
        icon: <IconSidebar />,
        label: 'Toggle Sidebar',
        description: (mobileViewport ? fileTreeOverlayOpen : sidebarVisible)
          ? 'Hide Source Control'
          : 'Show Source Control',
        keywords: 'source control explorer',
        run: toggleSidebar,
      },
      {
        id: 'toggle-diff-layout',
        icon: <IconDiffSplit />,
        label: 'Toggle Diff Layout',
        description: diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view',
        keywords: 'split unified view',
        run: () => setDiffStyle((style) => (style === 'split' ? 'unified' : 'split')),
      },
      {
        id: 'change-theme',
        icon: <IconThemes />,
        label: 'Change Theme',
        description:
          colorMode === 'system'
            ? 'Use light theme'
            : colorMode === 'light'
              ? 'Use dark theme'
              : 'Follow system theme',
        keywords: 'appearance light dark system color',
        run: () =>
          setColorMode(
            colorMode === 'system' ? 'light' : colorMode === 'light' ? 'dark' : 'system',
          ),
      },
    ]

    const currentPath =
      target?.filePath ??
      (target?.request?.scope === 'staged' || target?.request?.scope === 'unstaged'
        ? target.selectedPath
        : undefined)
    if (currentPath != null && worktreeDrafts.has(currentPath) && !repository.busy) {
      commands.push({
        id: 'save-file',
        icon: <IconCheck />,
        label: 'Save File',
        description: currentPath,
        keywords: 'write dirty changes',
        run: () => saveWorktreeFile(currentPath),
      })
    }
    const unstagedChange = repository.snapshot?.unstaged.find(
      (change) => change.path === currentPath,
    )
    if (unstagedChange != null && !repository.busy) {
      commands.push({
        id: 'stage-file',
        icon: <IconPlus />,
        label: 'Stage Current File',
        description: unstagedChange.path,
        keywords: 'git add',
        run: () =>
          repository.mutate({
            op: 'stage',
            paths: unstagedChange.oldPath
              ? [unstagedChange.oldPath, unstagedChange.path]
              : [unstagedChange.path],
          }),
      })
    }
    const stagedChange = repository.snapshot?.staged.find((change) => change.path === currentPath)
    if (stagedChange != null && !repository.busy) {
      commands.push({
        id: 'unstage-file',
        icon: <IconMinus />,
        label: 'Unstage Current File',
        description: stagedChange.path,
        keywords: 'git reset index',
        run: () =>
          repository.mutate({
            op: 'unstage',
            paths: stagedChange.oldPath
              ? [stagedChange.oldPath, stagedChange.path]
              : [stagedChange.path],
          }),
      })
    }

    if (!repository.busy) {
      for (const folder of repository.folders?.recent ?? []) {
        if (folder.path === repository.snapshot?.root) continue
        commands.push({
          id: `recent-folder:${folder.path}`,
          icon: <IconFolder />,
          label: `Open Recent Folder: ${folder.name}`,
          description: folder.path,
          keywords: 'recent history switch folder',
          run: () => requestFolderSwitch(folder.path, false),
        })
      }
      for (const branch of repository.branches) {
        if (branch.current || branch.remote) continue
        commands.push({
          id: `switch-branch:${branch.name}`,
          icon: <IconBranch />,
          label: `Switch Branch: ${branch.name}`,
          description: branch.upstream ?? 'Local branch',
          keywords: 'git checkout branch',
          run: () => repository.switchBranch(branch.name),
        })
      }
    }
    return commands
  }, [
    colorMode,
    diffStyle,
    fileTreeOverlayOpen,
    mobileViewport,
    openHome,
    repository,
    repository.branches,
    repository.busy,
    repository.folders?.recent,
    repository.generation,
    repository.snapshot?.root,
    requestFolderSwitch,
    saveWorktreeFile,
    sidebarVisible,
    target?.filePath,
    target?.request?.scope,
    target?.selectedPath,
    toggleSidebar,
    worktreeDrafts,
  ])

  return (
    <>
      <div
        aria-hidden={folderSwitchTransition != null || undefined}
        className="contents"
        inert={folderSwitchTransition != null || undefined}
      >
        <ReviewGrid containerRef={reviewRootRef} sidebarVisible={sidebarVisible}>
          {!homeOpen && (
            <DiffsHubHeader
              appVersion={repository.snapshot?.appVersion ?? 'dev'}
              className="[grid-area:header]"
              collapseMode={collapseMode}
              colorMode={colorMode}
              darkThemeName={darkThemeName}
              diffIndicators={diffIndicators}
              diffStyle={diffStyle}
              fileTreeAvailable={!homeOpen}
              fileTreeOverlayOpen={fileTreeOverlayOpen}
              githubTokenActive={false}
              homeButtonRef={homeButtonRef}
              initialUrl={repository.snapshot?.root ?? 'Loading repository…'}
              localRepository
              lightThemeName={lightThemeName}
              lineNumbers={lineNumbers}
              overflow={overflow}
              onClearGitHubToken={() => {}}
              onOpenHome={openHome}
              onOpenCommandPalette={() => setCommandPaletteOpen(true)}
              onSaveGitHubToken={() => {}}
              onOpenFolder={(path) => requestFolderSwitch(path, false)}
              onOpenFolderInNewTab={openFolderInNewTab}
              onRemoveRecentFolder={(path) => repository.removeRecentFolder(path)}
              onRevealFolder={async () => {
                setReviewActionError(null)
                try {
                  await repository.revealFolder()
                } catch (error) {
                  setReviewActionError(error instanceof Error ? error.message : String(error))
                }
              }}
              recentFolders={repository.folders?.recent}
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
          )}
          {homeOpen && (
            <GitnaHome
              catalog={repository.folders}
              error={repository.foldersError}
              loading={repository.foldersLoading}
              opening={repository.busy}
              switchError={homeSwitchError}
              onBack={closeHome}
              onClearSwitchError={() => setHomeSwitchError(null)}
              onOpenFolder={(path) => requestFolderSwitch(path, true)}
              onOpenFolderInNewTab={openFolderInNewTab}
              onRefresh={() => void repository.refreshFolders()}
              onRemoveRecentFolder={(path) => repository.removeRecentFolder(path)}
            />
          )}
          <div
            aria-hidden={homeOpen || undefined}
            className={homeOpen ? 'hidden' : 'contents'}
            inert={homeOpen || undefined}
          >
            {themesHydrated && (
              <DiffsHubSidebar
                className={cn(
                  '[grid-area:viewer] md:[grid-area:tree]',
                  !sidebarVisible && 'md:hidden',
                )}
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
                {repository.snapshot?.repository === false && target == null ? (
                  <FolderEmptyState />
                ) : loadState === 'ready' && reviewData != null && reviewData.items.length === 0 ? (
                  <GitnaEmptyState scope={target?.request?.scope} />
                ) : viewerAvailable && reviewData != null ? (
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
                    gitnaComparisonActions={gitnaComparisonActions}
                    gitnaEditorActions={gitnaEditorActions}
                    gitnaOpenFileAction={gitnaOpenFileAction}
                    onCommentDeleted={() => {}}
                    onCommentSaved={() => {}}
                    onLineLinkChange={handleLineLinkChange}
                    onScroll={handleReviewScroll}
                    onViewerReady={handleViewerReady}
                  />
                ) : (
                  <div className="grid h-full min-h-0 [&>*]:h-full">
                    <DiffsHubStatusPanel
                      contentKind={target?.filePath == null ? 'diff' : 'file'}
                      errorMessage={errorMessage ?? repository.error}
                      localRepository
                      onRetry={() => setReviewAttempt((attempt) => attempt + 1)}
                      state={loadState}
                    />
                  </div>
                )}
              </div>
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
        <GitnaCommandPalette
          commands={paletteCommands}
          error={repository.ordinarySearchError}
          externalFileResults={repository.ordinarySearchResults}
          fileSearchComplete={repository.ordinarySearchComplete}
          fileResultQuery={repository.ordinarySearchResultQuery}
          loading={
            repository.ordinarySearchLoading ||
            (!repository.ordinarySearchComplete && repository.ordinarySearchError == null)
          }
          open={commandPaletteOpen && !homeOpen}
          onClose={() => setCommandPaletteOpen(false)}
          onError={setReviewActionError}
          onFileQueryChange={searchOrdinaryPalette}
          onOpenFile={(path) => {
            setHomeOpen(false)
            return repository.openRepositoryFile(path, true)
          }}
        />
        {pendingFolderSwitch != null && (
          <Confirm
            title="Discard unsaved changes and switch folder?"
            message={`${dirtyPaths.size} unsaved ${dirtyPaths.size === 1 ? 'file' : 'files'} will be discarded.`}
            confirmLabel="Discard and switch"
            onCancel={() => setPendingFolderSwitch(null)}
            onConfirm={() => {
              const pending = pendingFolderSwitch
              setPendingFolderSwitch(null)
              void performFolderSwitch(pending.path, pending.returnHome, pending.focusTarget).catch(
                (error: unknown) =>
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
      </div>
      {folderSwitchTransition != null && <FolderLoadingScreen path={folderSwitchTransition.path} />}
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
  const comparison = repository.repositoryFileComparison
  useEffect(() => {
    const selector = repository.repositoryFileComparisonActive
      ? '[data-comparison-tab="true"]'
      : `[data-tab-index="${openPaths.indexOf(repository.repositoryFilePath ?? '')}"]`
    queueMicrotask(() =>
      tablistRef.current
        ?.querySelector<HTMLElement>(selector)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    )
  }, [openPaths, repository.repositoryFileComparisonActive, repository.repositoryFilePath])
  if (openPaths.length === 0 && comparison == null) return null
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
        {comparison != null && (
          <div
            data-comparison-tab="true"
            className={cn(
              'group/tab flex h-7 max-w-72 shrink-0 items-center rounded-md text-xs',
              repository.repositoryFileComparisonActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={repository.repositoryFileComparisonActive}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pl-2.5 text-left"
              title={`${comparison.leftPath} ↔ ${comparison.rightPath}`}
              onClick={() => repository.activateRepositoryFileComparison()}
            >
              <IconDiffSplit className="size-4 shrink-0" />
              <span className="truncate">
                {comparison.leftPath.split('/').at(-1) ?? comparison.leftPath} ↔{' '}
                {comparison.rightPath.split('/').at(-1) ?? comparison.rightPath}
              </span>
            </button>
            <button
              type="button"
              className="mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background/70 hover:text-foreground group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
              aria-label={`Close comparison of ${comparison.leftPath} and ${comparison.rightPath}`}
              title="Close comparison"
              onClick={() => repository.closeRepositoryFileComparison()}
            >
              <IconX className="size-3" />
            </button>
          </div>
        )}
        {openPaths.map((path, index) => {
          const active =
            !repository.repositoryFileComparisonActive && repository.repositoryFilePath === path
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
                'group/tab flex h-7 max-w-64 shrink-0 items-center rounded-md text-xs',
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

function FolderEmptyState() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 [grid-area:viewer]">
      <section role="status" className="max-w-md text-center">
        <h2 className="text-sm font-medium text-foreground">Select a file from Explorer</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose a file to open and edit it.</p>
      </section>
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

function ReviewGrid({
  children,
  containerRef,
  sidebarVisible,
}: {
  children: ReactNode
  containerRef: Ref<HTMLDivElement>
  sidebarVisible: boolean
}) {
  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Review"
      className={cn(
        "grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer']",
        sidebarVisible
          ? "md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']"
          : "md:grid-cols-1 md:[grid-template-areas:'header''viewer']",
      )}
    >
      {children}
    </div>
  )
}
