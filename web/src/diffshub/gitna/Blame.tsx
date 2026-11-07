import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { CodeViewHandle } from '@pierre/diffs/react'
import type { ApiClient } from '../../lib/api'
import type { FileBlame, LineHistory } from '../../lib/types'
import type { CommentMetadata } from '../lib/types'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/Tooltip'
import { CommitInfo } from './CommitInfo'
import { formatLineHistoryAge, lineHistoryFromBlame } from './lineHistory'
import { useRepository } from './repository'

export function Blame({
  path,
  generation,
  dirty,
  maxBytes,
  api,
  scrollRef,
  viewerRef,
  onOpenCommit,
}: {
  path: string
  generation: number
  dirty: boolean
  maxBytes?: number
  api: ApiClient
  scrollRef: RefObject<HTMLDivElement | null>
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>
  onOpenCommit: (history: LineHistory) => Promise<void>
}) {
  const repository = useRepository()
  const overlayRef = useRef<HTMLDivElement>(null)
  const cache = useMemo(() => new Map<number, LineHistory>(), [path, generation, dirty])
  const [line, setLine] = useState<number | null>(null)
  const [history, setHistory] = useState<LineHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [fileBlame, setFileBlame] = useState<FileBlame | 'loading' | 'failed'>('loading')
  const displayRef = useRef({ history, dirty, generation })
  const positionRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    displayRef.current = { history, dirty, generation }
    positionRef.current?.()
  }, [history, dirty, generation])

  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller == null) return
    let frame = 0
    const position = () => {
      const overlay = overlayRef.current
      const { history, dirty, generation } = displayRef.current
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
      setLine(caret.end.line + 1)
      if (
        dirty ||
        history == null ||
        history.uncommitted ||
        history.oid == null ||
        history.generation !== generation
      ) {
        hide()
        return
      }
      // Keep the previous annotation in place until the next line's result is ready.
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
      frame = requestAnimationFrame(position)
    }
    positionRef.current = position
    document.addEventListener('selectionchange', schedule)
    scroller.addEventListener('pointerup', schedule)
    scroller.addEventListener('keyup', schedule)
    scroller.addEventListener('scroll', schedule, true)
    const root = scroller.querySelector('diffs-container')?.shadowRoot
    root?.addEventListener('scroll', schedule, true)
    const resize = new ResizeObserver(schedule)
    resize.observe(scroller)
    position()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      positionRef.current = null
      document.removeEventListener('selectionchange', schedule)
      scroller.removeEventListener('pointerup', schedule)
      scroller.removeEventListener('keyup', schedule)
      scroller.removeEventListener('scroll', schedule, true)
      root?.removeEventListener('scroll', schedule, true)
    }
  }, [path, scrollRef, viewerRef])

  useEffect(() => {
    if (dirty) return
    if (api.fileBlame == null) {
      setFileBlame('failed')
      return
    }
    setFileBlame('loading')
    const controller = new AbortController()
    void api.fileBlame(path, controller.signal, maxBytes).then(
      (result) => {
        if (!controller.signal.aborted)
          setFileBlame(result.generation === generation ? result : 'failed')
      },
      () => {
        if (!controller.signal.aborted) setFileBlame('failed')
      },
    )
    return () => controller.abort()
  }, [api, path, generation, dirty, maxBytes])

  useEffect(() => {
    setTooltipOpen(false)
    setError(null)
    if (line == null || dirty || fileBlame === 'loading') return
    if (fileBlame !== 'failed') {
      setHistory(lineHistoryFromBlame(fileBlame, line))
      return
    }
    const cached = cache.get(line)
    if (cached != null) {
      setHistory(cached)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api.lineHistory(path, line, controller.signal, maxBytes).then(
        (result) => {
          if (!controller.signal.aborted && result.generation === generation) {
            cache.set(line, result)
            setHistory(result)
          }
        },
        () => {
          if (!controller.signal.aborted) setHistory(null)
        },
      )
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, path, line, generation, dirty, maxBytes, cache, fileBlame])

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
