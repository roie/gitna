import { isHomePath, resolveFolderHref } from './navigation'
import type { FileContents } from '@pierre/diffs'
import { EditStateManager, type EditorViewState } from '@pierre/diffs/edit'
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react'
import { buildPaletteCommands } from './commands'
import type { ColorMode } from '@pierre/theming'
import { useThemeController } from '@pierre/theming/react'
import {
  Suspense,
  lazy,
  type CSSProperties,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { WorkbenchHeader } from './workbench-header'
import { Sidebar } from './sidebar'
import { ReviewStatus } from '../features/viewer/review-status'
import { useViewSettings } from '../features/viewer/use-view-settings'
import {
  Viewer,
  getNextItemVersion,
  worktreeDiffStateKeys,
  type GitnaComparisonActions,
  type GitnaConversationActions,
  type GitnaEditorActions,
  type GitnaFileAction,
  type GitnaViewerActions,
} from '../features/viewer/viewer'
import { themeCatalog, themeController } from '../lib/theme/theme-root'
import type { CommentMetadata, ViewerLoadState } from '../lib/review-types'
import {
  ApiError,
  type ApiClient,
  type DiffRequest,
  type DraftRecord,
  type ReviewRequest,
} from '../lib/api'
import {
  ConversationsModel,
  type Conversation,
  type ConversationSurface,
} from '../lib/conversations'
import type {
  ContentSearchFile,
  DiffScope,
  FileDiff,
  ReviewIdentity,
  WorktreeFile,
} from '../lib/types'
import type { DarkThemeName, LightThemeName } from '../lib/theme/theme-names'
import type { LoadedReviewData } from '../features/viewer/review-data'
import { cn } from '../lib/cn'
import { savePreference } from '../lib/preferences'
import { DraftComment } from '../features/conversations/draft-comment'
import { relocateDraft } from '../features/conversations/draft-location'
import { Thread } from '../features/conversations/thread'
import { GlobalToastHost } from './connection-status'
import { LoadingScreen, folderDisplayName } from './loading-screen'
import { LoadingIndicator } from '../components/ui/loading'
import {
  markDestinationStartup,
  useFolderSwitch,
  type FolderSwitchOperation,
} from './use-folder-switch'
import { Home } from '../features/home/home'
import { Blame } from '../features/viewer/blame'
import { ChangeGutter } from '../features/viewer/change-gutter'
import { Panes } from './panes'
import { Confirm } from '../components/modal'
import { SaveAs } from '../features/viewer/save-as'
import { UnsavedChanges } from '../features/viewer/unsaved-changes'
import { DraftRecovery } from '../features/viewer/draft-recovery'
import { usePreview } from '../features/viewer/use-preview'
import { SVGPreview } from '../features/viewer/preview/svg-preview'
import { MediaPreview, nativeMediaKind } from '../features/viewer/preview/media-preview'
import { FolderEmptyState, GitnaEmptyState } from './empty-state'
import { TabBar } from './tab-bar'
import {
  adaptGitnaFile,
  appendGitnaReviewPage,
  createGitnaReviewAccumulator,
  adaptWorktreeComparison,
  adaptWorktreeFile,
  diffImageAnnotations,
  draftDiffItem,
  type GitnaReviewAccumulator,
} from '../features/viewer/review-adapter'
import {
  ActionGuardError,
  useRepository,
  type RepositoryFileComparison,
} from '../repository/repository'

const CommandPalette = lazy(() =>
  import('../features/command-palette/command-palette').then(({ CommandPalette }) => ({
    default: CommandPalette,
  })),
)
const FindInFiles = lazy(() =>
  import('../features/search/find-in-files').then(({ FindInFiles }) => ({ default: FindInFiles })),
)
const MarkdownPreview = lazy(() =>
  import('../features/viewer/preview/markdown-preview').then(({ MarkdownPreview }) => ({
    default: MarkdownPreview,
  })),
)

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

function updateViewerItems(
  viewer: CodeViewHandle<CommentMetadata, undefined>,
  current: LoadedReviewData,
  refreshed: LoadedReviewData,
  hasDraft: (path: string) => boolean,
): void {
  // An unsent comment draft lives only on the viewer item, so carry it over.
  const next = {
    ...refreshed,
    items: refreshed.items.map((item) => {
      if (item.annotations?.some(({ metadata }) => metadata.kind === 'draft')) return item
      const existing = viewer.getItem(item.id)
      const drafts =
        existing?.type === item.type
          ? existing.annotations?.filter(({ metadata }) => metadata.kind === 'draft')
          : undefined
      if (!drafts?.length) return item
      const placed = drafts.map((draft) =>
        relocateDraft(item, draft as Parameters<typeof relocateDraft>[1]),
      )
      return { ...item, annotations: [...(item.annotations ?? []), ...placed] } as typeof item
    }),
  }
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
  const sameItemKinds =
    next.items.length === current.items.length &&
    current.items.every((item, index) => {
      const nextItem = next.items[index]
      return item.id === nextItem?.id && item.type === nextItem.type
    })
  if (!sameItemKinds) {
    // Complete edits before reusing an ID for a different item kind. Pierre's
    // completion callback must still see the file item that owns the session.
    for (const item of current.items) {
      const existing = viewer.getItem(item.id)
      const replacement = next.items.find((candidate) => candidate.id === item.id)
      if (existing?.edit && replacement?.type !== existing.type) {
        viewer.updateItem({ ...existing, edit: false, version: (existing.version ?? 0) + 1 })
      }
    }
    viewer.getInstance()?.setItems(next.items)
    return
  }
  for (const item of next.items) {
    const existing = viewer.getItem(item.id)
    if (
      existing?.edit === true &&
      existing.type === item.type &&
      (item.type === 'file' || hasDraft(item.id))
    ) {
      // The live editor owns the draft, undo history, focus, and selection.
      // Refresh updates the surrounding review metadata, but must not replace
      // the item while a local edit session is active.
      continue
    }
    if (
      existing?.type === 'diff' &&
      item.type === 'diff' &&
      !item.fileDiff.isPartial &&
      existing.fileDiff.type === item.fileDiff.type &&
      existing.fileDiff.lang === item.fileDiff.lang &&
      existing.fileDiff.deletionLines.join('') === item.fileDiff.deletionLines.join('') &&
      viewer.getEditor(item.id)?.getText() === item.fileDiff.additionLines.join('')
    ) {
      viewer.updateItem({
        ...item,
        fileDiff: { ...item.fileDiff, cacheKey: existing.fileDiff.cacheKey },
      })
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
    if (error.code === 'unsupported-encoding') {
      return 'This file contains invalid UTF-8 text. Convert it to UTF-8 in another tool before opening it for editing. Gitna has not changed the file.'
    }
    if (error.code === 'file-not-found') {
      return 'This file is no longer available. Refresh Explorer or select another file.'
    }
  }
  return 'Gitna couldn’t read this file. Try again or select another file.'
}

/** Names the content each side of the open view shows, or null where code
 * cannot carry conversations. */
function conversationSurface(
  target: ReviewTarget | null,
  identity: ReviewIdentity | undefined,
  savedFile: boolean,
  unstaged: boolean,
): ConversationSurface | null {
  if (target == null) return null
  const worktree = { source: 'worktree' } as const
  if (target.comparison != null) return { view: 'file', additions: worktree, deletions: worktree }
  if (target.filePath != null) {
    if (!savedFile) return null
    // Without unstaged changes the file shows the staged code too.
    return unstaged
      ? { view: 'file', additions: worktree }
      : { view: 'file', additions: worktree, same: { source: 'index' } }
  }
  if (identity == null) return null
  const commit = (revision?: string) =>
    revision == null ? undefined : ({ source: 'commit', revision } as const)
  const after = commit(identity.after)
  switch (identity.scope) {
    case 'unstaged':
      return { view: 'worktree', additions: worktree, deletions: { source: 'index' } }
    case 'staged':
      return { view: 'index', additions: { source: 'index' }, deletions: commit(identity.before) }
    case 'commit':
    case 'compare':
      return after == null
        ? null
        : {
            view: identity.scope === 'commit' ? 'commit' : 'comparison',
            additions: after,
            deletions: commit(identity.before),
          }
  }
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

type WorkbenchProps = {
  homeOpen?: boolean
  onHomeNavigate?: (open: boolean) => void
  folderURL?: string
  searchRequest?: number
  focusOnReady?: boolean
  onFolderNavigate?: (href: string) => void
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void
}

export function Workbench({
  homeOpen: routedHomeOpen,
  onHomeNavigate,
  folderURL = window.location.href,
  searchRequest = 0,
  focusOnReady = false,
  onFolderNavigate,
  onNavigationGuardChange,
}: WorkbenchProps) {
  const repository = useRepository()
  const target = useReviewTarget()
  const nativePath =
    target?.filePath != null && nativeMediaKind(target.filePath) != null ? target.filePath : null
  const targetKeyRef = useRef(target?.key)
  targetKeyRef.current = target?.key
  const scopeKnownEmpty =
    (target?.request?.scope === 'staged' && repository.snapshot?.staged.length === 0) ||
    (target?.request?.scope === 'unstaged' && repository.snapshot?.unstaged.length === 0)
  const workerReady = useIsWorkerPoolReadyOrDisabled()
  const {
    diffStyle,
    setDiffStyle,
    collapseMode,
    setCollapseMode,
    overflow,
    setOverflow,
    showBackgrounds,
    setShowBackgrounds,
    inlineBlame,
    changeInlineBlame,
    diffIndicators,
    setDiffIndicators,
    lineNumbers,
    setLineNumbers,
  } = useViewSettings()
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false)
  const [mobileViewport, setMobileViewport] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarMode, setSidebarMode] = useState<'source' | 'search'>('source')
  const [searchMounted, setSearchMounted] = useState(false)
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  const openFindInFiles = useCallback(() => {
    setSearchFocusRequest((request) => request + 1)
    setSidebarMode('search')
    if (window.matchMedia('(max-width: 767px)').matches) setFileTreeOverlayOpen(true)
    else setSidebarVisible(true)
  }, [])

  useEffect(() => {
    if (searchRequest === 0) return
    setCommandPaletteOpen(false)
    openFindInFiles()
  }, [openFindInFiles, searchRequest])
  const [searchResults, setSearchResults] = useState<ContentSearchFile[]>([])
  const [activeSearchMatch, setActiveSearchMatch] = useState<{
    path: string
    line: number
    column: number
  }>()
  const [pendingSearchReveal, setPendingSearchReveal] = useState<{
    path: string
    line: number
    column: number
  } | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [paletteMounted, setPaletteMounted] = useState(false)
  useEffect(() => {
    if (sidebarMode === 'search') setSearchMounted(true)
    if (commandPaletteOpen) setPaletteMounted(true)
  }, [commandPaletteOpen, sidebarMode])
  const [commandPaletteInitialQuery, setCommandPaletteInitialQuery] = useState('')
  const [recentFilePaths, setRecentFilePaths] = useState<readonly string[]>([])
  const [showConversations, setShowConversations] = useState(() => {
    try {
      return localStorage.getItem('gitna:conversations') === 'true'
    } catch {
      return false
    }
  })
  const changeShowConversations = (enabled: boolean) => {
    setShowConversations(enabled)
    savePreference('gitna:conversations', String(enabled))
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<CodeViewHandle<CommentMetadata, undefined> | null>(null)
  const [reviewData, setReviewData] = useState<LoadedReviewData | null>(null)
  const previewFile = reviewData?.items[0]
  const previewFilePath = previewFile?.type === 'file' ? previewFile.file.name : undefined
  const {
    cachedPreviewPath,
    claimScroll,
    handleEditorScroll,
    handlePreviewMount,
    handlePreviewScroll,
    markdownPath,
    previewLabel,
    previewLayoutMode,
    previewMode,
    previewPath,
    setPreviewMode,
    svgPath,
  } = usePreview(previewFilePath, scrollRef, viewerRef)
  const [previewHeaderHeight, setPreviewHeaderHeight] = useState(44)
  const [themesHydrated, setThemesHydrated] = useState(false)
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [failedTargetKey, setFailedTargetKey] = useState<string | null>(null)
  const [fileErrorCode, setFileErrorCode] = useState<string | null>(null)
  const [largeFileWarning, setLargeFileWarning] = useState<{
    path: string
    sizeBytes: number
  } | null>(null)
  const approvedFileBudgetsRef = useRef(new Map<string, number>())
  const largeDraftBackupsRef = useRef(
    new Map<string, { record: DraftRecord; pending: Promise<void> }>(),
  )
  const [imageDiff, setImageDiff] = useState<FileDiff | null>(null)
  const [reviewAttempt, setReviewAttempt] = useState(0)
  const [reviewActionError, setReviewActionError] = useState<string | null>(null)
  const [localHomeOpen, setLocalHomeOpen] = useState(false)
  const homeOpen = routedHomeOpen ?? localHomeOpen
  const setHomeOpen = onHomeNavigate ?? setLocalHomeOpen
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
    closeComparison: boolean
  } | null>(null)
  const [pendingUntitledSaveAs, setPendingUntitledSaveAs] = useState<string | null>(null)
  const [recoverableDrafts, setRecoverableDrafts] = useState<readonly DraftRecord[]>([])
  const [draftRecoveryOpen, setDraftRecoveryOpen] = useState(false)
  const folderSwitchOperationRef = useRef<FolderSwitchOperation | null>(null)
  const allowFolderNavigationRef = useRef(false)
  const editorRepositoryRootRef = useRef<string | null>(null)
  const draftClientIdRef = useRef<string | null>(null)
  const reviewDataRef = useRef<LoadedReviewData | null>(null)
  const [draftOpen, setDraftOpen] = useState(false)
  const keptDraftItemIdsRef = useRef<ReadonlySet<string>>(new Set())
  const withDraftItems = useCallback((data: LoadedReviewData, sameReview: boolean) => {
    const viewer = viewerRef.current
    const current = reviewDataRef.current
    const kept =
      sameReview && viewer != null && current != null ? keepDraftItems(viewer, current, data) : data
    keptDraftItemIdsRef.current = new Set(
      kept.items.filter((item) => !data.items.includes(item)).map(({ id }) => id),
    )
    return kept
  }, [])
  const reviewScope = target?.request?.scope
  const heldScope =
    draftOpen && (reviewScope === 'staged' || reviewScope === 'unstaged') ? reviewScope : null
  useEffect(() => repository.holdScope(heldScope), [heldScope, repository])
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
  }, [target?.key])
  const worktreeComparisonRef = useRef<{ key: string; diff: FileDiff } | null>(null)
  // CodeView owns the imperative header root, so its save callback may outlive a React render.
  const savingPathRef = useRef<string | null>(null)
  const worktreeFilesRef = useRef(worktreeFiles)
  const worktreeDraftsRef = useRef(worktreeDrafts)
  const editorViewStatesRef = useRef(new Map<string, EditorViewState>())
  worktreeFilesRef.current = worktreeFiles
  worktreeDraftsRef.current = worktreeDrafts
  const [pendingFileAction, setPendingFileAction] = useState<{
    action: 'discard' | 'delete'
    path: string
    paths: string[]
  } | null>(null)
  const reviewRootRef = useRef<HTMLDivElement>(null)
  const destinationFocusRestored = useRef(false)
  useEffect(() => {
    if (!focusOnReady || destinationFocusRestored.current || repository.snapshot == null) return
    reviewRootRef.current?.focus({ preventScroll: true })
    destinationFocusRestored.current = true
  }, [focusOnReady, repository.snapshot])
  const homeButtonRef = useRef<HTMLButtonElement>(null)
  const restoreHomeFocusRef = useRef(false)
  const revealedReviewRef = useRef<{
    viewer: ReturnType<CodeViewHandle<CommentMetadata, undefined>['getInstance']>
    targetKey: string
    path: string
  } | null>(null)
  const reviewItemVersionRef = useRef(0)
  const [reviewCacheNamespace] = useState(() => `${crypto.randomUUID()}:`)
  const themeState = useThemeController(themeController)

  useEffect(() => {
    setThemesHydrated(true)
    markDestinationStartup()
    const loadDrafts = repository.api.drafts
    if (loadDrafts != null) {
      let active = true
      void loadDrafts()
        .then((drafts) => {
          if (!active || drafts.length === 0) return
          setRecoverableDrafts(drafts)
          setDraftRecoveryOpen(true)
        })
        .catch(() => undefined)
      return () => {
        active = false
        folderSwitchOperationRef.current?.controller.abort()
      }
    }
    return () => folderSwitchOperationRef.current?.controller.abort()
  }, [repository.api])

  useEffect(() => {
    return () => folderSwitchOperationRef.current?.controller.abort()
  }, [])

  useEffect(() => {
    const root = repository.snapshot?.root
    if (homeOpen) document.title = 'Gitna'
    else if (root != null) document.title = `${repositoryName(root)} - Gitna`
  }, [homeOpen, repository.snapshot?.root])

  useEffect(() => {
    const path = repository.repositoryFilePath
    if (path == null) return
    setRecentFilePaths((current) =>
      [...current.filter((candidate) => candidate !== path), path].slice(-20),
    )
  }, [repository.repositoryFilePath])

  const untitledDocuments = repository.untitledDocuments()
  const untitledDraftKey = untitledDocuments
    .map((document) => `${document.id}:${document.revision}:${document.dirty}`)
    .join('|')

  useEffect(() => {
    const putDraft = repository.api.putDraft
    if (putDraft == null) return
    if (draftClientIdRef.current == null) {
      draftClientIdRef.current =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    }
    const timers = untitledDocuments
      .filter((draft) => draft.dirty)
      .map((draft) =>
        window.setTimeout(() => {
          void putDraft({
            schema: 1,
            documentId: draft.id,
            clientId: draftClientIdRef.current!,
            folderKey: draft.folderKey,
            path: draft.path,
            label: draft.label,
            revision: draft.revision,
            contents: draft.contents,
            baselineHash: draft.baselineHash,
            maxBytes: repository.draftMaxBytes(`untitled:${draft.id}`),
            updatedAt: new Date().toISOString(),
          }).catch((error: unknown) => {
            setReviewActionError(
              `Could not back up ${draft.label}: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        }, 500),
      )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [repository.api, untitledDraftKey])

  useEffect(() => {
    const putDraft = repository.api.putDraft
    if (putDraft == null) return
    const timers: number[] = []
    for (const [path, draft] of worktreeDrafts) {
      const budget = approvedFileBudgetsRef.current.get(path)
      const baseline = worktreeFilesRef.current.get(path)
      if (budget == null || baseline == null || path.startsWith('untitled:')) continue
      timers.push(
        window.setTimeout(() => {
          const previous = largeDraftBackupsRef.current.get(path)
          if (previous?.record.contents === draft.contents && previous.record.path === path) return
          const record: DraftRecord = {
            schema: 1,
            documentId: previous?.record.documentId ?? crypto.randomUUID(),
            clientId: draftClientIdRef.current!,
            folderKey: repository.snapshot?.root,
            path,
            label: path,
            revision: (previous?.record.revision ?? 0) + 1,
            contents: draft.contents,
            baselineHash: baseline.hash,
            maxBytes: budget,
            updatedAt: new Date().toISOString(),
          }
          const pending = (previous?.pending ?? Promise.resolve())
            .then(async () => {
              await putDraft(record)
            })
            .catch((error: unknown) => {
              setReviewActionError(
                `Could not back up ${path}: ${error instanceof Error ? error.message : String(error)}`,
              )
            })
          largeDraftBackupsRef.current.set(path, { record, pending })
        }, 500),
      )
    }
    for (const [path, backup] of largeDraftBackupsRef.current) {
      if (worktreeDrafts.has(path)) continue
      const deleteDraft = repository.api.deleteDraft
      if (deleteDraft == null) continue
      largeDraftBackupsRef.current.delete(path)
      void backup.pending
        .then(() => deleteDraft(backup.record.documentId, backup.record.revision))
        .catch((error: unknown) =>
          setReviewActionError(
            `Could not remove draft backup: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [repository.api, repository.snapshot?.root, worktreeDrafts])

  useEffect(() => {
    const root = repository.snapshot?.root
    if (root == null) return
    if (editorRepositoryRootRef.current != null && editorRepositoryRootRef.current !== root) {
      approvedFileBudgetsRef.current.clear()
      largeDraftBackupsRef.current.clear()
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
    approvedFileBudgetsRef.current = new Map(
      [...approvedFileBudgetsRef.current].map(([path, budget]) => [
        remapWorktreePath(path, rename.source, rename.destination),
        budget,
      ]),
    )
    largeDraftBackupsRef.current = new Map(
      [...largeDraftBackupsRef.current].map(([path, backup]) => [
        remapWorktreePath(path, rename.source, rename.destination),
        backup,
      ]),
    )
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
      editorViewStatesRef.current.has(target.filePath)
    if (!refreshingVisibleReview && reviewDataRef.current == null) {
      renderedTargetKeyRef.current = null
      setReviewData(null)
      setLoadState('fetching')
    }
    setErrorMessage(null)
    setFileErrorCode(null)
    setLargeFileWarning(null)
    const loadRepositoryFile = async (path: string): Promise<LoadedReviewData> => {
      try {
        const untitled = repository.untitledDocument(path)
        if (untitled != null) {
          const loaded: WorktreeFile = { path, content: untitled.contents, hash: '' }
          setWorktreeFiles((current) => new Map(current).set(path, loaded))
          return adaptWorktreeFile(loaded, repository.generation, undefined, reviewCacheNamespace)
        }
        const loaded = await repository.api.readWorktreeFile(
          path,
          approvedFileBudgetsRef.current.get(path),
          worktreeFilesRef.current.get(path),
        )
        reviewAbortController.signal.throwIfAborted()
        const rename = repository.worktreeRename
        const previousPath =
          rename == null ? path : previousWorktreePath(path, rename.source, rename.destination)
        const previousDraft = worktreeDraftsRef.current.get(previousPath)
        const storedDraft =
          worktreeDraftsRef.current.get(path) ??
          (previousDraft == null ? undefined : { ...previousDraft, name: path })
        const draft = storedDraft
        if (draft == null) {
          const previous = worktreeFilesRef.current.get(path)
          if (previous != null && previous.hash !== loaded.hash) {
            EditStateManager.clear('file', `${reviewCacheNamespace}worktree:${path}`)
          }
          setWorktreeFiles((current) => new Map(current).set(path, loaded))
        }
        const baseline =
          draft == null
            ? loaded
            : (worktreeFilesRef.current.get(path) ??
              worktreeFilesRef.current.get(previousPath) ??
              loaded)
        return adaptWorktreeFile(
          { ...baseline, path },
          repository.generation,
          draft,
          reviewCacheNamespace,
        )
      } catch (error) {
        const draft = worktreeDraftsRef.current.get(path)
        const baseline = worktreeFilesRef.current.get(path)
        if (draft != null && baseline != null) {
          return adaptWorktreeFile(baseline, repository.generation, draft, reviewCacheNamespace)
        }
        const unavailableTextFile =
          error instanceof ApiError &&
          (error.code === 'binary-file' || error.code === 'file-too-large')
        if (!unavailableTextFile) throw error
        if (error.code === 'file-too-large' && !rasterImagePattern.test(path)) throw error
        if (/\.(md|markdown|mdown|mkdn)$/i.test(path)) throw error
        if (!repository.snapshot?.repository) {
          if (!rasterImagePattern.test(path)) throw error
          const diff = await repository.api.compareWorktreeFiles(
            path,
            path,
            reviewAbortController.signal,
          )
          if (diff.tooLarge || diff.after.image == null) throw error
          return adaptGitnaFile(diff, repository.generation, reviewCacheNamespace)
        }
        const diff = await repository.api.diff({ scope: 'unstaged', path })
        return adaptGitnaFile(diff, repository.generation, reviewCacheNamespace)
      }
    }
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
      const leftDraft = worktreeDraftsRef.current.get(comparison.leftPath)
      const rightDraft = worktreeDraftsRef.current.get(comparison.rightPath)
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
      return withDiffDrafts(
        repository.api,
        () => worktreeDraftsRef.current,
        result.data,
        request.scope,
      )
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
      updateViewerItems(viewer, previousData, reviewData, (path) =>
        worktreeDraftsRef.current.has(path),
      )
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
          const data = await withDiffDrafts(
            repository.api,
            () => worktreeDraftsRef.current,
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

  const handleReviewScroll = useCallback(
    (scrollTop: number) => {
      const scroller = scrollRef.current
      if (scroller == null) return
      const remaining = scroller.scrollHeight - scrollTop - scroller.clientHeight
      if (remaining <= scroller.clientHeight) void loadMoreReview()
      handleEditorScroll()
    },
    [handleEditorScroll, loadMoreReview],
  )

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
  const viewerThemeType = themesHydrated ? themeState.resolvedColorScheme : colorMode
  const lightThemeName = themesHydrated
    ? themeState.lightThemeName
    : themeCatalog.defaultLightThemeName
  const darkThemeName = themesHydrated
    ? themeState.darkThemeName
    : themeCatalog.defaultDarkThemeName
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
  }, [applyCollapseMode, collapseMode, setCollapseMode])

  const goToLine = useCallback(
    (line: number, column = 0) => {
      const path = target?.filePath
      const viewer = viewerRef.current
      if (path == null || viewer == null) return false
      const item = viewer.getItem(path)
      if (item?.type !== 'file') return false
      const lineCount = item.file.contents.split('\n').length
      const clampedLine = Math.max(1, Math.min(lineCount, line))
      viewer.scrollTo({ type: 'line', id: path, lineNumber: clampedLine - 1, align: 'center' })
      // SAFETY: Editable file items expose Pierre's Editor through the narrower DiffsEditor interface.
      const editor = viewer.getEditor(path) as unknown as
        | { focus(options: { lineNumber: number; character: number }): void }
        | undefined
      if (editor == null) return false
      editor.focus({ lineNumber: clampedLine, character: column })
      return true
    },
    [target?.filePath],
  )

  const handleEditorReady = useCallback(() => {
    if (pendingSearchReveal != null && target?.filePath === pendingSearchReveal.path) {
      if (goToLine(pendingSearchReveal.line, pendingSearchReveal.column))
        setPendingSearchReveal(null)
    }
  }, [goToLine, pendingSearchReveal, target?.filePath])

  const handleViewerReady = useCallback(() => {
    if (target?.filePath != null || target?.selectedPath == null) {
      revealedReviewRef.current = null
      return
    }
    if (reviewData == null || renderedTargetKeyRef.current !== target.key) return
    const handle = viewerRef.current
    const viewer = handle?.getInstance()
    if (viewer == null) return
    const previousReveal = revealedReviewRef.current
    // A background refresh is not navigation; let CodeView preserve its reading anchor.
    if (
      previousReveal?.viewer === viewer &&
      previousReveal.targetKey === target.key &&
      previousReveal.path === target.selectedPath
    )
      return
    const itemId = reviewData.treeSource.pathToItemId.get(target.selectedPath)
    if (itemId == null || handle?.getItem(itemId) == null) return
    const reveal = { viewer, targetKey: target.key, path: target.selectedPath }
    revealedReviewRef.current = reveal
    requestAnimationFrame(() => {
      if (revealedReviewRef.current !== reveal || viewerRef.current?.getInstance() !== viewer)
        return
      handle.scrollTo({
        type: 'item',
        id: itemId,
        align: 'start',
        behavior: 'instant',
      })
    })
  }, [reviewData, target?.filePath, target?.key, target?.selectedPath])

  useEffect(() => {
    handleViewerReady()
  }, [handleViewerReady])

  const comparisonPending = target?.request?.scope === 'compare' && repository.compareLoading
  const comparisonError = target?.request?.scope === 'compare' ? repository.compareError : null
  const surfaceState = comparisonPending
    ? 'fetching'
    : comparisonError != null
      ? 'error'
      : loadState === 'error' && (failedTargetKey !== target?.key || errorMessage == null)
        ? 'fetching'
        : loadState
  const viewerAvailable =
    workerReady && themesHydrated && surfaceState === 'ready' && reviewData != null

  useEffect(() => {
    if (
      !viewerAvailable ||
      reviewData.items.length === 0 ||
      previewMode === 'editor' ||
      previewFilePath == null
    )
      return
    let frame = 0
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    let scroller: HTMLDivElement | null = null
    let root: ShadowRoot | null = null
    let update: (() => void) | null = null
    const attach = () => {
      scroller = scrollRef.current
      const header = scroller
        ?.querySelector('diffs-container')
        ?.shadowRoot?.querySelector<HTMLElement>('[data-diffs-header]')
      if (header == null || scroller == null) {
        frame = requestAnimationFrame(attach)
        return
      }
      const viewport = scroller
      const shadowRoot = header.getRootNode() as ShadowRoot
      root = shadowRoot
      update = () =>
        setPreviewHeaderHeight(
          Math.max(0, header.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top),
        )
      update()
      resizeObserver = new ResizeObserver(update)
      resizeObserver.observe(header)
      resizeObserver.observe(viewport)
      viewport.addEventListener('scroll', update)
      if (previewMode === 'preview') {
        const hideEditor = () => {
          for (const pre of shadowRoot.querySelectorAll<HTMLElement>('pre')) {
            pre.inert = true
            pre.setAttribute('aria-hidden', 'true')
          }
        }
        hideEditor()
        mutationObserver = new MutationObserver(hideEditor)
        mutationObserver.observe(shadowRoot, { childList: true, subtree: true })
      }
    }
    attach()
    return () => {
      cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      if (update != null) scroller?.removeEventListener('scroll', update)
      for (const pre of root?.querySelectorAll<HTMLElement>('pre') ?? []) {
        pre.inert = false
        pre.removeAttribute('aria-hidden')
      }
    }
  }, [viewerAvailable, reviewData, previewMode, previewFilePath])

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

  const backendDisabledReason = repository.getActionDisabledReason()
  const openFolderDisabledReason = repository.getActionDisabledReason('open-folder')
  const workingScope =
    target?.request?.scope === 'staged' || target?.request?.scope === 'unstaged'
      ? target.request.scope
      : null
  const [reviewIdentity, setReviewIdentity] = useState<{
    key: string
    identity: ReviewIdentity
  } | null>(null)
  const [conversationsModel, setConversationsModel] = useState<ConversationsModel | null>(null)
  useEffect(() => {
    const api = repository.api.conversations
    if (!showConversations || api == null || repository.snapshot == null) return
    const model = new ConversationsModel(api)
    setConversationsModel(model)
    return () => {
      model.dispose()
      setConversationsModel(null)
    }
  }, [repository.api, repository.snapshot == null, showConversations])
  const repositoryGeneration = repository.generation
  const connected = repository.connectionState === 'connected'
  useEffect(() => {
    // File edits move code under existing threads, so relocate them.
    if (conversationsModel != null && connected) void conversationsModel.load()
  }, [conversationsModel, repositoryGeneration, connected])
  const gitnaActions: GitnaViewerActions | undefined =
    workingScope == null
      ? undefined
      : {
          scope: workingScope,
          cacheNamespace: reviewCacheNamespace,
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
            const reason = repository.getActionDisabledReason()
            if (reason != null) {
              setReviewActionError(reason)
              return
            }
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
          onRevealFile(path) {
            void repository
              .revealPath(path)
              .catch((error: unknown) =>
                setReviewActionError(error instanceof Error ? error.message : String(error)),
              )
          },
          onPatch(request) {
            const reason = repository.getActionDisabledReason()
            if (reason != null) return Promise.reject(new ActionGuardError(reason))
            setReviewActionError(null)
            return repository.mutate(request)
          },
          onError: setReviewActionError,
          disabledReason: backendDisabledReason,
        }

  const gitnaOpenFileAction =
    repository.activeReview !== 'commit' || repository.commitDiff == null
      ? undefined
      : {
          ariaLabel: (path: string) => `Open ${path} in Repository`,
          canOpenFile: (path: string) => repository.canOpenRepositoryFile(path),
          onOpenFile: (path: string) => {
            void repository
              .openRepositoryFile(path, true)
              .catch((error: unknown) =>
                setReviewActionError(error instanceof Error ? error.message : String(error)),
              )
          },
        }

  const dirtyPathsKey = [...worktreeDrafts.keys()].join('\0')
  const dirtyPaths = useMemo(
    () => new Set(dirtyPathsKey === '' ? [] : dirtyPathsKey.split('\0')),
    [dirtyPathsKey],
  )
  useEffect(() => {
    conversationsModel?.setUnsavedCount(dirtyPaths.size)
  }, [conversationsModel, dirtyPaths.size])
  useEffect(() => {
    onNavigationGuardChange?.(() => {
      if (repository.busy || savingPathRef.current != null) return false
      return (
        worktreeDraftsRef.current.size === 0 ||
        window.confirm('You have unsaved file changes. Leave this folder and discard them?')
      )
    })
    return () => onNavigationGuardChange?.(null)
  }, [repository, onNavigationGuardChange])
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
  }, [setHomeOpen])
  const closeHome = useCallback(() => {
    restoreHomeFocusRef.current = true
    if (isHomePath(new URL(folderURL).pathname) && repository.snapshot != null) {
      void repository
        .openFolder(repository.snapshot.root)
        .then((result) => {
          const target = resolveFolderHref(result.href, folderURL).href
          if (onFolderNavigate != null) onFolderNavigate(target)
          else window.location.assign(target)
        })
        .catch((error: unknown) => {
          setHomeSwitchError(error instanceof Error ? error.message : String(error))
        })
      return
    }
    setHomeOpen(false)
  }, [folderURL, onFolderNavigate, repository, setHomeOpen])
  useEffect(() => {
    if (homeOpen || !restoreHomeFocusRef.current) return
    restoreHomeFocusRef.current = false
    homeButtonRef.current?.focus()
  }, [homeOpen])
  const {
    folderSwitchTransition,
    openFolderInNewTab,
    pendingFolderSwitch,
    performFolderSwitch,
    requestFolderSwitch,
    setPendingFolderSwitch,
  } = useFolderSwitch({
    allowFolderNavigationRef,
    closeHome,
    colorMode,
    operationRef: folderSwitchOperationRef,
    dirty: dirtyPaths.size > 0,
    folderURL,
    onFolderNavigate,
    repository,
    setHomeOpen,
    setHomeSwitchError,
    setReviewActionError,
  })
  const closeRepositoryFiles = useCallback(
    (paths: readonly string[], closeComparison = false) => {
      const uniquePaths = [...new Set(paths)].filter((path) =>
        repository.repositoryOpenPaths.includes(path),
      )
      if (uniquePaths.length === 0 && !closeComparison) return
      const dirty = uniquePaths.filter(
        (path) => dirtyPaths.has(path) || worktreeDraftsRef.current.has(path),
      )
      if (dirty.length > 0) {
        setPendingTabClose({ paths: uniquePaths, dirtyPaths: dirty, closeComparison })
        return
      }
      repository.closeRepositoryFiles(uniquePaths, closeComparison)
    },
    [dirtyPaths, repository],
  )
  const handleWorktreeEditChange = useCallback(
    (path: string, file: FileContents, viewState: EditorViewState) => {
      editorViewStatesRef.current.set(path, viewState)
      repository.updateUntitledContent(path, file.contents)
      setRecentlySavedPath((current) => (current === path ? null : current))
      const next = new Map(worktreeDraftsRef.current)
      const baseline = worktreeFilesRef.current.get(path)
      if (
        savingPathRef.current !== path &&
        baseline != null &&
        baseline.content === file.contents
      ) {
        next.delete(path)
      } else next.set(path, file)
      worktreeDraftsRef.current = next
      setWorktreeDrafts(next)
    },
    [repository],
  )
  const baselineLoadsRef = useRef(new Map<string, Promise<void>>())
  const diffDraftsRef = useRef(new Map<string, FileContents | undefined>())
  const handleDiffEdit = useCallback(
    (path: string, file: FileContents, reviewedContents: string) => {
      const saved = worktreeFilesRef.current.get(path)?.content ?? reviewedContents
      if (!worktreeDraftsRef.current.has(path) && file.contents === saved) return
      EditStateManager.clear('file', `${reviewCacheNamespace}worktree:${path}`)
      if (!worktreeFilesRef.current.has(path) && !baselineLoadsRef.current.has(path)) {
        const load = repository.api
          .readWorktreeFile(path)
          .then((loaded) => {
            if (worktreeFilesRef.current.has(path)) return
            const nextFiles = new Map(worktreeFilesRef.current).set(path, loaded)
            worktreeFilesRef.current = nextFiles
            setWorktreeFiles(nextFiles)
          })
          .catch((error: unknown) =>
            setReviewActionError(error instanceof Error ? error.message : String(error)),
          )
          .finally(() => baselineLoadsRef.current.delete(path))
        baselineLoadsRef.current.set(path, load)
      }
      setRecentlySavedPath((current) => (current === path ? null : current))
      const next = new Map(worktreeDraftsRef.current)
      const baseline = worktreeFilesRef.current.get(path)
      if (
        savingPathRef.current !== path &&
        baseline != null &&
        baseline.content === file.contents
      ) {
        next.delete(path)
      } else next.set(path, { ...file, name: path })
      diffDraftsRef.current.set(path, next.get(path))
      worktreeDraftsRef.current = next
      setWorktreeDrafts(next)
    },
    [repository, reviewCacheNamespace],
  )
  useEffect(() => {
    for (const [path, draft] of diffDraftsRef.current) {
      if (worktreeDrafts.get(path) === draft) continue
      diffDraftsRef.current.delete(path)
      for (const key of worktreeDiffStateKeys(reviewCacheNamespace, path)) {
        EditStateManager.clear('file-diff', key)
      }
    }
  }, [reviewCacheNamespace, worktreeDrafts])
  const saveWorktreeFileNow = useCallback(
    async (path: string): Promise<boolean> => {
      await baselineLoadsRef.current.get(path)
      const baseline = worktreeFilesRef.current.get(path)
      const draft = worktreeDraftsRef.current.get(path)
      if (baseline == null || draft == null || savingPathRef.current != null) return false
      const reason = repository.getActionDisabledReason()
      if (reason != null) {
        setReviewActionError(reason)
        return false
      }
      const submittedContent = draft.contents
      savingPathRef.current = path
      setSavingPath(path)
      setReviewActionError(null)
      try {
        const approvedBudget = approvedFileBudgetsRef.current.get(path)
        const maxBytes =
          approvedBudget == null
            ? undefined
            : Math.max(approvedBudget, new TextEncoder().encode(submittedContent).length)
        const saved = await repository.saveWorktreeFile(
          path,
          submittedContent,
          baseline.hash,
          maxBytes,
        )
        if (maxBytes != null) approvedFileBudgetsRef.current.set(path, maxBytes)
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
        return false
      } finally {
        const activeDraft = worktreeDraftsRef.current.get(path)
        if (activeDraft?.contents === worktreeFilesRef.current.get(path)?.content) {
          const nextDrafts = new Map(worktreeDraftsRef.current)
          nextDrafts.delete(path)
          worktreeDraftsRef.current = nextDrafts
          setWorktreeDrafts(nextDrafts)
        }
        savingPathRef.current = null
        setSavingPath(null)
      }
      return !worktreeDraftsRef.current.has(path)
    },
    [repository],
  )
  const saveInFlightRef = useRef<Promise<boolean> | null>(null)
  const saveWorktreeFile = useCallback(
    async (path: string): Promise<boolean> => {
      let waited = false
      while (saveInFlightRef.current != null) {
        waited = true
        await saveInFlightRef.current.catch(() => false)
      }
      if (waited && !worktreeDraftsRef.current.has(path)) return true
      const save = saveWorktreeFileNow(path)
      saveInFlightRef.current = save
      try {
        return await save
      } finally {
        if (saveInFlightRef.current === save) saveInFlightRef.current = null
      }
    },
    [saveWorktreeFileNow],
  )
  const savePendingTabs = useCallback(async () => {
    const pending = pendingTabClose
    if (pending == null) return
    const untitled = pending.dirtyPaths.find((path) => repository.isUntitledPath(path))
    if (untitled != null) {
      setPendingUntitledSaveAs(untitled)
      return
    }
    for (const path of pending.paths) {
      if (!worktreeDraftsRef.current.has(path)) continue
      if (!(await saveWorktreeFile(path))) return
    }
    if (pending.paths.some((path) => worktreeDraftsRef.current.has(path))) return
    setPendingTabClose(null)
    repository.closeRepositoryFiles(pending.paths, pending.closeComparison)
  }, [pendingTabClose, repository, saveWorktreeFile])

  const discardPendingTabs = useCallback(async () => {
    const pending = pendingTabClose
    if (pending == null) return
    try {
      for (const path of pending.dirtyPaths) {
        if (repository.isUntitledPath(path)) await repository.discardUntitledDocument(path)
      }
      setWorktreeDrafts((current) => {
        const next = new Map(current)
        for (const path of pending.dirtyPaths) next.delete(path)
        return next
      })
      setPendingTabClose(null)
      repository.closeRepositoryFiles(pending.paths, pending.closeComparison)
    } catch (error) {
      setReviewActionError(error instanceof Error ? error.message : String(error))
    }
  }, [pendingTabClose, repository])

  const requestSave = useCallback(
    (path: string) => {
      if (repository.isUntitledPath(path)) {
        setPendingUntitledSaveAs(path)
        return
      }
      void saveWorktreeFile(path)
    },
    [repository, saveWorktreeFile],
  )
  const previewValue =
    previewPath == null
      ? null
      : (worktreeDrafts.get(previewPath)?.contents ??
        worktreeFiles.get(previewPath)?.content ??
        null)
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
          disabledReason: backendDisabledReason,
          onChange: handleWorktreeEditChange,
          onOpenChange: (scope, path) => repository.select(scope, path),
          onSave: requestSave,
          ...(previewPath == null
            ? {}
            : { previewMode, onPreviewModeChange: setPreviewMode, previewLabel }),
        }
      : undefined
  const conversationSurfaceKey = JSON.stringify(
    conversationSurface(
      target,
      reviewIdentity?.key === target?.key ? reviewIdentity?.identity : undefined,
      gitnaEditorActions != null && !repository.isUntitledPath(target?.filePath ?? ''),
      target?.filePath != null && repository.hasChange('unstaged', target.filePath),
    ),
  )
  const gitnaConversations = useMemo<GitnaConversationActions | undefined>(() => {
    const surface = JSON.parse(conversationSurfaceKey) as ConversationSurface | null
    return conversationsModel == null || surface == null
      ? undefined
      : {
          model: conversationsModel,
          surface,
          visible: showConversations,
          renderThread: (conversation, model) => (
            <Thread conversation={conversation} model={model} />
          ),
          renderDraftComment: (props) => <DraftComment {...props} />,
        }
  }, [conversationsModel, conversationSurfaceKey, showConversations])

  useEffect(() => {
    const path = target?.filePath
    const viewer = viewerRef.current
    const item = path == null ? null : viewer?.getItem(path)
    if (path == null || viewer == null || item?.type !== 'file' || viewer.getEditor(path) != null)
      return
    item.version = typeof item.version === 'number' ? item.version + 1 : 1
    viewer.updateItem(item)
  }, [dirtyPaths, recentlySavedPath, savingPath, target?.filePath])

  useEffect(() => {
    const onSave = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      if (
        target?.filePath == null &&
        event.target instanceof Node &&
        scrollRef.current?.contains(event.target) === true
      ) {
        const paths = (reviewDataRef.current?.items ?? []).flatMap((item) => {
          if (item.edit !== true) return []
          const path = item.type === 'diff' ? item.fileDiff.name : item.file.name
          return worktreeDraftsRef.current.has(path) ? [path] : []
        })
        if (paths.length === 0) return
        event.preventDefault()
        for (const path of paths) void saveWorktreeFile(path)
        return
      }
      const path = target?.filePath
      if (
        path == null ||
        (!worktreeDraftsRef.current.has(path) && !repository.isUntitledPath(path))
      )
        return
      event.preventDefault()
      requestSave(path)
    }
    window.addEventListener('keydown', onSave)
    return () => window.removeEventListener('keydown', onSave)
  }, [dirtyPaths, repository, requestSave, saveWorktreeFile, target?.filePath])

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
    (query: string, includeIgnored: boolean) =>
      void repository.searchOrdinaryFiles(query, paletteFileHistory, includeIgnored),
    [paletteFileHistory, repository],
  )

  useEffect(() => {
    const onGoToLine = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'g') {
        return
      }
      event.preventDefault()
      setCommandPaletteInitialQuery(':')
      setCommandPaletteOpen(true)
    }
    window.addEventListener('keydown', onGoToLine)
    return () => window.removeEventListener('keydown', onGoToLine)
  }, [])

  useSyncExternalStore(
    useCallback(
      (listener: () => void) => conversationsModel?.subscribe(listener) ?? (() => {}),
      [conversationsModel],
    ),
    () => conversationsModel?.version ?? 0,
  )
  // Opens the view a conversation was started in, at its file.
  const openConversation = useCallback(
    async (conversation: Conversation) => {
      const { anchor } = conversation
      const path = conversation.location?.path ?? conversation.path
      conversationsModel?.setExpanded(conversation.id, true)
      const { location } = conversation
      const openFile = async () => {
        setPendingSearchReveal({ path, line: location?.startLine ?? anchor.startLine, column: 1 })
        await repository.openRepositoryFile(path, true)
      }
      // A diff exists only while the file has changes there; without one, the
      // file itself shows the same code.
      const openDiff = (scope: 'staged' | 'unstaged') =>
        repository.hasChange(scope, path) ? repository.select(scope, path) : openFile()
      // The file is gone; show the deletion of the content Git still has.
      if (location?.source === 'index') {
        await openDiff('unstaged')
        return
      }
      if (location?.source === 'commit' && location.revision != null) {
        if (location.revision === repository.snapshot?.headOid) {
          await openDiff('staged')
          return
        }
        await repository.openCompare(
          location.revision.slice(0, 12),
          repository.snapshot?.headOid?.slice(0, 12) ?? 'HEAD',
          'Conversation',
        )
        const file = repository.compareFiles.find((candidate) => candidate.path === path)
        if (file != null) repository.selectCompareFile(file)
        return
      }
      if (anchor.source === 'worktree') {
        await openFile()
        return
      }
      const head = repository.snapshot?.headOid
      if (anchor.view === 'worktree' || (anchor.view === 'index' && anchor.source === 'index')) {
        await openDiff(anchor.view === 'worktree' ? 'unstaged' : 'staged')
        return
      }
      if (anchor.view === 'index' && anchor.revision === head) {
        await openDiff('staged')
        return
      }
      const [from, to] =
        anchor.side === 'additions'
          ? [anchor.against, anchor.revision]
          : [anchor.revision, anchor.against]
      const file = { path, kind: 'modified' } as const
      if (anchor.view === 'comparison' && from != null && to != null) {
        await repository.openCompare(from.slice(0, 12), to.slice(0, 12), 'Conversation')
        repository.selectCompareFile(file)
        return
      }
      // A staged-diff anchor on a commit that is no longer HEAD lives on in that commit.
      const commit = anchor.view === 'commit' ? (to ?? anchor.revision) : anchor.revision
      if (commit == null) return
      await repository.openCommit(commit, 'Conversation')
      repository.selectCommitFile(commit, 'Conversation', file)
    },
    [conversationsModel, repository],
  )
  const conversationsPane = useMemo(
    () =>
      conversationsModel == null
        ? undefined
        : {
            model: conversationsModel,
            onOpen: (conversation: Conversation) => {
              setFileTreeOverlayOpen(false)
              void openConversation(conversation)
            },
          },
    [conversationsModel, openConversation],
  )
  const paletteCommands = useMemo(
    () =>
      buildPaletteCommands({
        backendDisabledReason,
        colorMode,
        diffStyle,
        fileTreeOverlayOpen,
        mobileViewport,
        openFindInFiles,
        openFolderDisabledReason,
        openHome,
        previewLabel,
        previewMode,
        previewPath,
        repository,
        requestFolderSwitch,
        saveWorktreeFile,
        setColorMode,
        setDiffStyle,
        setPendingUntitledSaveAs,
        setPreviewMode,
        setSidebarMode,
        sidebarVisible,
        target,
        toggleSidebar,
        worktreeDrafts,
      }),
    [
      colorMode,
      diffStyle,
      fileTreeOverlayOpen,
      previewMode,
      previewPath,
      previewLabel,
      mobileViewport,
      openHome,
      repository,
      repository.branches,
      repository.busy,
      backendDisabledReason,
      openFindInFiles,
      openFolderDisabledReason,
      repository.folders?.recent,
      repository.generation,
      repository.snapshot?.root,
      requestFolderSwitch,
      saveWorktreeFile,
      sidebarVisible,
      target,
      setColorMode,
      setDiffStyle,
      setPreviewMode,
      toggleSidebar,
      worktreeDrafts,
    ],
  )

  const untitledSaveBudget =
    pendingUntitledSaveAs == null ? undefined : repository.draftMaxBytes(pendingUntitledSaveAs)
  const startupLoading = repository.snapshot == null && repository.error == null
  const loadingPath =
    folderSwitchTransition?.path ??
    (startupLoading
      ? decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? 'folder')
      : null)

  return (
    <>
      <div
        aria-hidden={loadingPath != null || undefined}
        className="contents"
        inert={loadingPath != null || undefined}
      >
        <ReviewGrid containerRef={reviewRootRef} sidebarVisible={sidebarVisible}>
          {!homeOpen && (
            <WorkbenchHeader
              appVersion={repository.snapshot?.appVersion ?? 'dev'}
              className="z-40 [grid-area:header]"
              collapseMode={collapseMode}
              colorMode={colorMode}
              darkThemeName={darkThemeName}
              diffIndicators={diffIndicators}
              diffStyle={diffStyle}
              fileTreeAvailable={!homeOpen}
              fileTreeOverlayOpen={fileTreeOverlayOpen}
              homeButtonRef={homeButtonRef}
              initialUrl={repository.snapshot?.root ?? ''}
              lightThemeName={lightThemeName}
              lineNumbers={lineNumbers}
              overflow={overflow}
              onOpenHome={openHome}
              onOpenCommandPalette={() => setCommandPaletteOpen(true)}
              onOpenFolder={(path) => requestFolderSwitch(path, false)}
              backendDisabledReason={backendDisabledReason}
              openFolderDisabledReason={openFolderDisabledReason}
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
              inlineBlame={inlineBlame}
              setInlineBlame={changeInlineBlame}
              conversations={showConversations}
              setConversations={
                repository.api.conversations == null ? undefined : changeShowConversations
              }
              setShowBackgrounds={setShowBackgrounds}
              showBackgrounds={showBackgrounds}
            />
          )}
          {homeOpen && (
            <Home
              catalog={repository.folders}
              error={repository.foldersError}
              loading={repository.foldersLoading}
              opening={repository.busy}
              switchError={homeSwitchError}
              onBack={closeHome}
              onClearSwitchError={() => setHomeSwitchError(null)}
              onOpenFolder={(path) => requestFolderSwitch(path, true)}
              backendDisabledReason={backendDisabledReason}
              openFolderDisabledReason={openFolderDisabledReason}
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
              <Sidebar
                ariaLabel={sidebarMode === 'search' ? 'Search' : 'Source Control'}
                className={cn(
                  '[grid-area:viewer] md:[grid-area:tree]',
                  !sidebarVisible && 'md:hidden',
                )}
                mobileOverlayOpen={fileTreeOverlayOpen}
                onMobileClose={() => setFileTreeOverlayOpen(false)}
                scrollRef={scrollRef}
              >
                {(searchMounted || sidebarMode === 'search') && (
                  <Suspense
                    fallback={
                      <LoadingIndicator>
                        <div role="status">Loading search…</div>
                      </LoadingIndicator>
                    }
                  >
                    <FindInFiles
                      key={repository.snapshot?.root}
                      active={sidebarMode === 'search'}
                      focusRequest={searchFocusRequest}
                      api={repository.api}
                      folderLabel={
                        folderDisplayName(repository.snapshot?.root ?? '') || 'current folder'
                      }
                      onBack={() => setSidebarMode('source')}
                      onResultsChange={setSearchResults}
                      onOpen={(path, line, column) => {
                        setActiveSearchMatch({ path, line, column })
                        setPendingSearchReveal(
                          target?.filePath === path && goToLine(line, column)
                            ? null
                            : { path, line, column },
                        )
                        setFileTreeOverlayOpen(false)
                        void repository.openRepositoryFile(path, true)
                      }}
                    />
                  </Suspense>
                )}
                <Panes
                  active={sidebarMode === 'source'}
                  onFindInFiles={openFindInFiles}
                  conversations={showConversations ? conversationsPane : undefined}
                  onSearchCommits={() => {
                    setCommandPaletteInitialQuery('#')
                    setCommandPaletteOpen(true)
                  }}
                />
              </Sidebar>
            )}
            <div className="flex min-h-0 flex-col [grid-area:viewer]">
              <TabBar
                dirtyPaths={dirtyPaths}
                onClose={closeRepositoryFiles}
                onError={setReviewActionError}
              />
              <div className="relative min-h-0 flex-1">
                {nativePath != null && (
                  <div
                    className={cn(
                      'h-full min-h-0',
                      reviewData != null && 'invisible absolute inset-0',
                    )}
                    aria-hidden={reviewData != null || undefined}
                    inert={reviewData != null}
                  >
                    <MediaPreview
                      key={`${repository.snapshot?.root}:${nativePath}`}
                      path={nativePath}
                      onReady={handleNativeReady}
                    />
                  </div>
                )}
                {nativePath != null && reviewData == null ? null : repository.snapshot
                    ?.repository === false && target == null ? (
                  <FolderEmptyState />
                ) : surfaceState === 'ready' &&
                  ((scopeKnownEmpty && !draftOpen) ||
                    (reviewData != null && reviewData.items.length === 0)) ? (
                  <GitnaEmptyState scope={target?.request?.scope} />
                ) : viewerAvailable && reviewData != null ? (
                  <div
                    className={cn(
                      'relative h-full min-h-0',
                      previewPath != null && 'markdown-file-view',
                      previewPath != null && previewMode === 'preview' && 'markdown-preview-open',
                      previewPath != null &&
                        previewMode === 'split' &&
                        'grid grid-cols-2 max-[700px]:grid-cols-1 max-[700px]:grid-rows-2',
                      markdownPath != null && previewMode === 'split' && 'markdown-split-view',
                    )}
                    style={
                      { '--markdown-header-height': `${previewHeaderHeight}px` } as CSSProperties
                    }
                  >
                    {target != null && renderedTargetKeyRef.current !== target.key && (
                      <LoadingIndicator operation={target.key}>
                        <div
                          role="status"
                          className="pointer-events-none absolute z-20 max-w-full rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground"
                          style={{ insetBlockEnd: '0.75rem', insetInlineEnd: '0.75rem' }}
                        >
                          {target.filePath == null ? 'Fetching diff…' : 'Opening file…'}
                        </div>
                      </LoadingIndicator>
                    )}
                    <div
                      className="h-full min-h-0"
                      onWheelCapture={() => claimScroll('editor')}
                      onTouchMoveCapture={() => claimScroll('editor')}
                      onKeyDownCapture={(event) => claimScroll('editor', event.key)}
                    >
                      <Viewer
                        className="code-view h-full"
                        diffStyle={diffStyle}
                        overflow={overflow}
                        showBackgrounds={showBackgrounds}
                        diffIndicators={diffIndicators}
                        lineNumbers={lineNumbers}
                        scrollRef={scrollRef}
                        themeType={viewerThemeType}
                        viewerRef={viewerRef}
                        initialItems={reviewData.items}
                        editStateNamespace={reviewCacheNamespace}
                        onDiffEdit={handleDiffEdit}
                        dirtyPaths={dirtyPaths}
                        gitnaActions={gitnaActions}
                        gitnaComparisonActions={gitnaComparisonActions}
                        gitnaEditorActions={gitnaEditorActions}
                        gitnaOpenFileAction={gitnaOpenFileAction}
                        gitnaConversations={gitnaConversations}
                        onDraftChange={setDraftOpen}
                        onScroll={handleReviewScroll}
                        onViewerReady={handleViewerReady}
                        onEditorReady={handleEditorReady}
                        searchMatches={
                          sidebarMode === 'search'
                            ? searchResults.find((file) => file.path === target?.filePath)?.matches
                            : undefined
                        }
                        activeSearchMatch={
                          activeSearchMatch?.path === target?.filePath
                            ? activeSearchMatch
                            : undefined
                        }
                      />
                    </div>
                    {target?.filePath != null &&
                      repository.snapshot?.repository === true &&
                      gitnaEditorActions != null &&
                      (previewPath == null || previewMode !== 'preview') && (
                        <ChangeGutter
                          key={repository.snapshot.root}
                          path={target.filePath}
                          indexRevision={repository.snapshot.indexRevision ?? repository.generation}
                          maxBytes={approvedFileBudgetsRef.current.get(target.filePath)}
                          contents={
                            worktreeDrafts.get(target.filePath)?.contents ??
                            worktreeFiles.get(target.filePath)?.content
                          }
                          api={repository.api}
                          scrollRef={scrollRef}
                        />
                      )}
                    {inlineBlame &&
                      target?.filePath != null &&
                      repository.snapshot?.repository === true &&
                      gitnaEditorActions != null &&
                      (previewPath == null || previewMode === 'editor') && (
                        <Blame
                          key={`${repository.snapshot.root}:${target.filePath}`}
                          path={target.filePath}
                          contentHash={worktreeFiles.get(target.filePath)?.hash}
                          headOid={repository.snapshot.headOid}
                          dirty={dirtyPaths.has(target.filePath)}
                          maxBytes={approvedFileBudgetsRef.current.get(target.filePath)}
                          api={repository.api}
                          scrollRef={scrollRef}
                          viewerRef={viewerRef}
                          onOpenCommit={async (history) => {
                            if (history.oid == null) return
                            await repository.loadCommitDetails(history.oid)
                            const files = repository.commitFiles[history.oid]
                            if (files == null)
                              throw new Error(
                                repository.filesError[history.oid] ?? 'Commit details unavailable',
                              )
                            const path = history.commitPath ?? history.path
                            const file = files.find(
                              (file) => file.path === path || file.oldPath === path,
                            ) ?? { path, kind: 'modified' as const }
                            repository.selectCommitFile(
                              history.oid,
                              history.summary ?? history.oid,
                              file,
                            )
                          }}
                        />
                      )}
                    {previewPath != null &&
                      (previewMode !== 'editor' || cachedPreviewPath === previewPath) && (
                        <div
                          className={cn(
                            'flex min-h-0 flex-col bg-background',
                            previewMode === 'editor' && 'invisible pointer-events-none',
                            previewLayoutMode === 'preview'
                              ? 'absolute inset-x-0 bottom-0 z-10'
                              : cn(
                                  'h-full border-l border-border max-[700px]:border-l-0 max-[700px]:border-t',
                                  previewMode === 'editor' &&
                                    'absolute right-0 top-0 w-1/2 max-[700px]:top-auto max-[700px]:bottom-0 max-[700px]:h-1/2 max-[700px]:w-full',
                                ),
                          )}
                          aria-hidden={previewMode === 'editor' || undefined}
                          inert={previewMode === 'editor'}
                          onWheelCapture={() => claimScroll('preview')}
                          onTouchMoveCapture={() => claimScroll('preview')}
                          onKeyDownCapture={(event) => claimScroll('preview', event.key)}
                          style={
                            previewLayoutMode === 'preview'
                              ? { top: previewHeaderHeight }
                              : undefined
                          }
                        >
                          {previewLayoutMode === 'split' && (
                            <div
                              className="flex shrink-0 items-center border-b border-border px-4 text-xs text-muted-foreground"
                              style={{ height: previewHeaderHeight }}
                            >
                              Preview
                            </div>
                          )}
                          <div className="min-h-0 flex-1">
                            <Suspense
                              fallback={
                                <LoadingIndicator operation={previewPath}>
                                  <div className="p-4 text-sm" role="status">
                                    Loading preview…
                                  </div>
                                </LoadingIndicator>
                              }
                            >
                              {svgPath != null ? (
                                <SVGPreview
                                  key={svgPath}
                                  value={previewValue}
                                  active={previewMode !== 'editor'}
                                />
                              ) : (
                                <MarkdownPreview
                                  key={markdownPath}
                                  scrollRef={handlePreviewMount}
                                  onScroll={handlePreviewScroll}
                                  onOpenPath={(path) => {
                                    void repository
                                      .openRepositoryFile(path, true)
                                      .catch((error: unknown) =>
                                        setReviewActionError(
                                          error instanceof Error ? error.message : String(error),
                                        ),
                                      )
                                  }}
                                  path={previewPath}
                                  value={previewValue}
                                  active={previewMode !== 'editor'}
                                />
                              )}
                            </Suspense>
                          </div>
                        </div>
                      )}
                  </div>
                ) : (
                  <div className="grid h-full min-h-0 [&>*]:h-full">
                    <ReviewStatus
                      operation={target?.key}
                      contentKind={target?.filePath == null ? 'diff' : 'file'}
                      errorMessage={
                        largeFileWarning != null && largeFileWarning.path === target?.filePath
                          ? `This file is ${(largeFileWarning!.sizeBytes / 1048576).toFixed(2)} MiB. Opening it may use a lot of memory or make this tab unresponsive. Very long lines and millions of lines are especially demanding.`
                          : (comparisonError ?? errorMessage ?? repository.error)
                      }
                      onOpenAnyway={
                        largeFileWarning?.path === target?.filePath && largeFileWarning != null
                          ? () => {
                              approvedFileBudgetsRef.current.set(
                                largeFileWarning.path,
                                largeFileWarning.sizeBytes,
                              )
                              setLargeFileWarning(null)
                              setLoadState('fetching')
                              setReviewAttempt((attempt) => attempt + 1)
                            }
                          : undefined
                      }
                      onRetry={
                        fileErrorCode === 'unsupported-encoding' ||
                        fileErrorCode === 'binary-file' ||
                        fileErrorCode === 'file-too-large'
                          ? undefined
                          : () => {
                              if (
                                target?.request?.scope === 'compare' &&
                                repository.compare != null
                              ) {
                                void repository.openCompare(
                                  repository.compare.from,
                                  repository.compare.to,
                                  repository.compare.label,
                                )
                              }
                              setReviewAttempt((attempt) => attempt + 1)
                            }
                      }
                      suppressError={
                        loadState === 'error' &&
                        (repository.connectionState !== 'connected' ||
                          errorMessage === 'Failed to fetch' ||
                          repository.error === 'Failed to fetch')
                      }
                      state={surfaceState}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </ReviewGrid>
        <GlobalToastHost
          actionError={reviewActionError}
          onDismissActionError={() => setReviewActionError(null)}
          toasts={[
            ...(conversationsModel?.error == null || !connected
              ? []
              : [
                  {
                    id: 'conversation-error',
                    title: conversationsModel.error,
                    severity: 'error' as const,
                    onDismiss: () => conversationsModel.dismissError(),
                  },
                ]),
            ...(conversationsModel?.recentlyDeletedMessage == null
              ? []
              : [
                  {
                    id: 'conversation-message-deleted',
                    title: 'Comment deleted',
                    severity: 'info' as const,
                    onDismiss: () => conversationsModel.dismissDeletedMessage(),
                    action: {
                      label: 'Undo',
                      onClick: () => {
                        const { conversation, message } = conversationsModel.recentlyDeletedMessage!
                        void conversationsModel.setMessageDeleted(conversation, message, false)
                      },
                    },
                  },
                ]),
            ...(conversationsModel?.recentlyDeleted == null
              ? []
              : [
                  {
                    id: 'conversation-deleted',
                    title: 'Conversation deleted',
                    severity: 'info' as const,
                    onDismiss: () => conversationsModel.dismissDeleted(),
                    action: {
                      label: 'Undo',
                      onClick: () =>
                        void conversationsModel.setDeleted(
                          conversationsModel.recentlyDeleted!,
                          false,
                        ),
                    },
                  },
                ]),
          ]}
        />
        {(paletteMounted || commandPaletteOpen) && (
          <Suspense fallback={null}>
            <CommandPalette
              commands={paletteCommands}
              searchCommits={
                repository.snapshot?.repository ? repository.api.searchCommits : undefined
              }
              repositoryKey={`${repository.snapshot?.root}:${repository.snapshot?.headOid}`}
              onOpenCommit={(oid, subject, currentBranch) => {
                setHomeOpen(false)
                if (currentBranch) {
                  setSidebarMode('source')
                  if (mobileViewport) setFileTreeOverlayOpen(true)
                  else setSidebarVisible(true)
                }
                return repository.openCommit(oid, subject, currentBranch)
              }}
              error={repository.ordinarySearchError}
              externalFileResults={repository.ordinarySearchResults}
              fileSearchComplete={repository.ordinarySearchComplete}
              fileResultIncludeIgnored={repository.ordinarySearchResultIncludeIgnored}
              fileResultQuery={repository.ordinarySearchResultQuery}
              folderLabel={folderDisplayName(repository.snapshot?.root ?? '') || 'Folder'}
              searching={repository.ordinarySearchLoading}
              supportsIgnoredFiles={repository.snapshot?.repository ?? false}
              open={commandPaletteOpen && !homeOpen}
              initialQuery={commandPaletteInitialQuery}
              onClose={() => {
                setCommandPaletteOpen(false)
                setCommandPaletteInitialQuery('')
              }}
              onError={setReviewActionError}
              onFileQueryChange={searchOrdinaryPalette}
              onGoToLine={goToLine}
              onOpenFile={(path) => {
                setHomeOpen(false)
                return repository.openRepositoryFile(path, true)
              }}
            />
          </Suspense>
        )}
        {pendingFolderSwitch != null && (
          <Confirm
            title="Discard unsaved changes and switch folder?"
            message={`${dirtyPaths.size} unsaved ${dirtyPaths.size === 1 ? 'file' : 'files'} will be discarded.`}
            confirmLabel="Discard and switch"
            onCancel={() => setPendingFolderSwitch(null)}
            disabledReason={repository.getActionDisabledReason('open-folder')}
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
        {draftRecoveryOpen && recoverableDrafts.length > 0 && (
          <DraftRecovery
            drafts={recoverableDrafts}
            onClose={() => setDraftRecoveryOpen(false)}
            onRestore={(draft) => {
              void repository.restoreDraft(draft).then(() => {
                setRecoverableDrafts((current) =>
                  current.filter((candidate) => candidate.documentId !== draft.documentId),
                )
                setDraftRecoveryOpen(false)
              })
            }}
            onDiscard={(draft) => {
              if (repository.api.deleteDraft == null) return
              void repository.api
                .deleteDraft(draft.documentId, draft.revision)
                .then(() => {
                  setRecoverableDrafts((current) =>
                    current.filter((candidate) => candidate.documentId !== draft.documentId),
                  )
                  if (recoverableDrafts.length <= 1) setDraftRecoveryOpen(false)
                })
                .catch((error: unknown) =>
                  setReviewActionError(
                    `Could not discard ${draft.label}: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                )
            }}
          />
        )}
        {pendingTabClose != null && (
          <UnsavedChanges
            dirtyPaths={pendingTabClose.dirtyPaths}
            saveDisabledReason={savingPath == null ? backendDisabledReason : 'Saving changes…'}
            onCancel={() => setPendingTabClose(null)}
            onDiscard={() => void discardPendingTabs()}
            onSave={() => void savePendingTabs()}
          />
        )}
        {pendingUntitledSaveAs != null && (
          <SaveAs
            documentPath={pendingUntitledSaveAs}
            initialPath={`${repository.untitledDocument(pendingUntitledSaveAs)?.label ?? 'untitled'}.txt`}
            onClose={() => setPendingUntitledSaveAs(null)}
            onError={setReviewActionError}
            onSaved={(path, file) => {
              const source = pendingUntitledSaveAs
              const budget = untitledSaveBudget
              if (budget != null) {
                approvedFileBudgetsRef.current.set(
                  path,
                  Math.max(budget, new TextEncoder().encode(file.content).length),
                )
              }
              setPendingUntitledSaveAs(null)
              setWorktreeFiles((current) => {
                const next = new Map(current)
                next.delete(source)
                next.set(path, file)
                return next
              })
              setWorktreeDrafts((current) => {
                const next = new Map(current)
                next.delete(source)
                return next
              })
              const pending = pendingTabClose
              if (pending == null) return
              const remainingDirty = pending.dirtyPaths.filter((candidate) => candidate !== source)
              repository.closeRepositoryFiles([path])
              if (remainingDirty.length === 0) {
                repository.closeRepositoryFiles(
                  pending.paths.filter((candidate) => candidate !== source),
                  pending.closeComparison,
                )
                setPendingTabClose(null)
              } else {
                setPendingTabClose({
                  paths: pending.paths.filter((candidate) => candidate !== source),
                  dirtyPaths: remainingDirty,
                  closeComparison: pending.closeComparison,
                })
              }
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
            disabledReason={repository.getActionDisabledReason()}
            onCancel={() => setPendingFileAction(null)}
            onConfirm={async () => {
              const pending = pendingFileAction
              setPendingFileAction(null)
              await repository
                .mutate({ op: pending.action, paths: pending.paths })
                .catch((error: unknown) =>
                  setReviewActionError(error instanceof Error ? error.message : String(error)),
                )
            }}
          />
        )}
      </div>
      {loadingPath != null && (
        <LoadingScreen
          path={loadingPath}
          startup={folderSwitchTransition == null && startupLoading}
        />
      )}
    </>
  )
}

function useIsWorkerPoolReadyOrDisabled(): boolean {
  const workerPool = useWorkerPool()
  const [ready, setReady] = useState(
    () => workerPool == null || workerPool.isInitialized() || !workerPool.isWorkingPool(),
  )
  const readyRef = useRef(ready)
  useEffect(
    () =>
      workerPool?.subscribeToStatChanges((stats) => {
        const next = stats.managerState === 'initialized' || stats.workersFailed
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
  const repository = useRepository()
  const connectionUnavailable =
    repository.connectionState === 'reconnecting' ||
    repository.connectionState === 'unreachable' ||
    repository.connectionState === 'session-error'

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Review"
      tabIndex={-1}
      aria-busy={connectionUnavailable || undefined}
      data-connection-state={repository.connectionState}
      className={cn(
        connectionUnavailable && 'pointer-events-none grayscale opacity-60',
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
