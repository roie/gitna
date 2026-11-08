import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { CodeViewHandle } from '@pierre/diffs/react'
import type { ApiClient } from '../../lib/api'
import type { FileBlame, LineHistory } from '../../lib/types'
import type { CommentMetadata } from '../lib/types'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/Tooltip'
import { CommitInfo } from './CommitInfo'
import { formatLineHistoryAge, lineHistoryFromBlame } from './lineHistory'
import { useRepository } from './repository'

const blameCache = new WeakMap<ApiClient, Map<string, FileBlame>>()

export function Blame({
  path,
  contentHash,
  headOid,
  dirty,
  maxBytes,
  api,
  scrollRef,
  viewerRef,
  onOpenCommit,
}: {
  path: string
  contentHash: string | undefined
  headOid: string | undefined
  dirty: boolean
  maxBytes?: number
  api: ApiClient
  scrollRef: RefObject<HTMLDivElement | null>
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>
  onOpenCommit: (history: LineHistory) => Promise<void>
}) {
  const repository = useRepository()
  const overlayRef = useRef<HTMLDivElement>(null)
  const indexMissing =
    repository.snapshot?.staged.some(
      (change) => change.path === path && change.kind === 'deleted',
    ) ?? false
  const key = JSON.stringify([
    repository.snapshot?.root,
    path,
    contentHash,
    headOid,
    maxBytes,
    indexMissing,
  ])
  const [line, setLine] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [result, setResult] = useState<{ key: string; blame: FileBlame } | null>(null)
  const fileBlame = result?.key === key ? result.blame : null
  const history = useMemo(
    () =>
      fileBlame == null || line == null || dirty || indexMissing
        ? null
        : lineHistoryFromBlame(fileBlame, line),
    [fileBlame, line, dirty, indexMissing],
  )
  const displayRef = useRef({ history, dirty, line })
  const positionRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    displayRef.current = { history, dirty, line }
    positionRef.current?.()
  }, [history, dirty, line])

  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller == null) return
    let frame = 0
    const position = (syncSelection: boolean) => {
      const overlay = overlayRef.current
      if (overlay == null) return
      const hide = () => {
        overlay.style.visibility = 'hidden'
      }
      const selection = viewerRef.current?.getEditor(path)?.getViewState().selections
      const caret = selection?.[0]
      if (
        caret == null ||
        selection?.length !== 1 ||
        caret.start.line !== caret.end.line ||
        caret.start.character !== caret.end.character
      ) {
        hide()
        return
      }
      const nextLine = caret.end.line + 1
      if (displayRef.current.line !== nextLine) {
        if (syncSelection) flushSync(() => setLine(nextLine))
        else {
          setLine(nextLine)
          return
        }
      }
      const { history, dirty } = displayRef.current
      if (
        dirty ||
        history == null ||
        history.uncommitted ||
        history.oid == null ||
        history.line !== caret.end.line + 1
      ) {
        hide()
        return
      }
      const root = scroller.querySelector('diffs-container')?.shadowRoot
      const row = root?.querySelector<HTMLElement>(
        `[data-line][data-line-index="${history.line - 1}"][data-line-type="context"]`,
      )
      if (row == null) {
        hide()
        return
      }
      const range = document.createRange()
      range.selectNodeContents(row)
      const rects = range.getClientRects()
      const text = rects[rects.length - 1] ?? row.getBoundingClientRect()
      const viewport = scroller.getBoundingClientRect()
      const parent = overlay.offsetParent?.getBoundingClientRect()
      const left = text.right + 24
      if (
        parent == null ||
        text.top < viewport.top + 40 ||
        text.bottom > viewport.bottom ||
        viewport.right - left < 100
      ) {
        hide()
        return
      }
      overlay.style.insetInlineStart = `${left - parent.left}px`
      overlay.style.insetBlockStart = `${text.top + (text.height - overlay.offsetHeight) / 2 - parent.top}px`
      overlay.style.maxWidth = `${viewport.right - left - 16}px`
      overlay.style.visibility = 'visible'
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => position(true))
    }
    positionRef.current = () => position(false)
    document.addEventListener('selectionchange', schedule)
    scroller.addEventListener('pointerup', schedule)
    scroller.addEventListener('keyup', schedule)
    scroller.addEventListener('scroll', schedule, true)
    const root = scroller.querySelector('diffs-container')?.shadowRoot
    root?.addEventListener('scroll', schedule, true)
    const resize = new ResizeObserver(schedule)
    resize.observe(scroller)
    const mutations = new MutationObserver(schedule)
    if (root != null) mutations.observe(root, { childList: true, subtree: true })
    position(false)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      positionRef.current = null
      document.removeEventListener('selectionchange', schedule)
      scroller.removeEventListener('pointerup', schedule)
      scroller.removeEventListener('keyup', schedule)
      scroller.removeEventListener('scroll', schedule, true)
      root?.removeEventListener('scroll', schedule, true)
    }
  }, [path, scrollRef, viewerRef])

  useEffect(() => {
    if (api.fileBlame == null || contentHash == null) return
    let cache = blameCache.get(api)
    if (cache == null) {
      cache = new Map()
      blameCache.set(api, cache)
    }
    const cached = cache.get(key)
    if (cached != null) {
      setResult({ key, blame: cached })
      return
    }
    const controller = new AbortController()
    void api.fileBlame(path, controller.signal, maxBytes).then(
      (blame) => {
        if (
          controller.signal.aborted ||
          blame.contentHash !== contentHash ||
          blame.headOid !== (headOid ?? '')
        )
          return
        if (cache.size >= 4) cache.clear()
        cache.set(key, blame)
        setResult({ key, blame })
      },
      () => {
        if (!controller.signal.aborted) setResult(null)
      },
    )
    return () => controller.abort()
  }, [api, path, key, contentHash, headOid, maxBytes])

  useEffect(() => {
    setTooltipOpen(false)
    setError(null)
  }, [key, line, dirty])

  const committed = history != null && !history.uncommitted && history.oid != null
  const age = history?.authoredAt == null ? null : formatLineHistoryAge(history.authoredAt)
  const label = committed ? [history.author, age, history.summary].filter(Boolean).join(' · ') : ''
  const graphCommit = repository.graphCommits.find((commit) => commit.oid === history?.oid)

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-clip">
      <div
        ref={overlayRef}
        className="pointer-events-auto invisible absolute text-xs leading-5 text-muted-foreground/65"
      >
        <TooltipProvider delayDuration={500}>
          <Tooltip
            open={tooltipOpen}
            onOpenChange={(open) => {
              setTooltipOpen(open)
              if (open && committed) void repository.loadCommitDetails(history.oid!)
            }}
          >
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex max-w-full cursor-default items-center gap-1 overflow-clip whitespace-nowrap text-start focus-visible:outline focus-visible:outline-ring active:text-muted-foreground"
                aria-label={
                  committed ? `Open commit ${history.shortOid}: ${history.summary}` : label
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (committed)
                    void onOpenCommit(history).catch((reason: unknown) => {
                      setError(reason instanceof Error ? reason.message : String(reason))
                      setTooltipOpen(true)
                    })
                }}
              >
                {committed ? (
                  <>
                    <span className="shrink-0">
                      {[history.author, age].filter(Boolean).join(' · ')}
                    </span>
                    {history.summary && (
                      <span className="min-w-0 truncate">· {history.summary}</span>
                    )}
                  </>
                ) : (
                  label
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="start"
              className="data-[state=delayed-open]:animate-none"
            >
              {error ??
                (committed ? (
                  <CommitInfo
                    commit={
                      graphCommit ?? {
                        oid: history.oid!,
                        subject: history.summary ?? '',
                        authorName: history.author ?? '',
                        authorTime: history.authoredAt ?? '',
                        refs: [],
                      }
                    }
                    stats={repository.commitStats[history.oid!]}
                    error={repository.filesError[history.oid!]}
                  />
                ) : (
                  label
                ))}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
