import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { IconChevronSm } from '@pierre/icons'
import type { ContentSearchFile, ContentSearchMatch } from '../../lib/types'
import { cn } from '../lib/cn'
import { FileTypeIcon } from './FileTypeIcon'

type SearchRow =
  | { key: string; file: ContentSearchFile; match?: undefined }
  | { key: string; file: ContentSearchFile; match: ContentSearchMatch }

export function SearchResults({
  files,
  collapsedFiles,
  selectedMatch,
  focusRequest,
  active,
  onToggle,
  onOpen,
  onEscape,
}: {
  files: ContentSearchFile[]
  collapsedFiles: ReadonlySet<string>
  selectedMatch: string | null
  focusRequest: number
  active: boolean
  onToggle: (path: string, collapse: boolean) => void
  onOpen: (key: string, path: string, line: number, column: number) => void
  onEscape: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<string | null>(null)
  const handledFocusRequest = useRef(focusRequest)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const rows = useMemo(
    () =>
      files.flatMap((file): SearchRow[] => [
        { key: `file:${file.path}`, file },
        ...(collapsedFiles.has(file.path)
          ? []
          : file.matches.map((match, index) => ({
              key: `${file.path}:${match.line}:${match.column}:${index}`,
              file,
              match,
            }))),
      ]),
    [files, collapsedFiles],
  )
  const focusedIndex = rows.findIndex((row) => row.key === focusedKey)
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: active,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index].key,
    estimateSize: (index) => (rows[index].match == null ? 28 : 24),
    overscan: 4,
    // Keep keyboard focus mounted even when the user scrolls it out of view.
    rangeExtractor: (range) =>
      [
        ...new Set([...defaultRangeExtractor(range), ...(focusedIndex < 0 ? [] : [focusedIndex])]),
      ].sort((a, b) => a - b),
  })
  const focusRow = (index: number) => {
    const row = rows[index]
    if (row == null) return
    pendingFocus.current = row.key
    setFocusedKey(row.key)
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }
  useLayoutEffect(() => {
    if (handledFocusRequest.current !== focusRequest) {
      handledFocusRequest.current = focusRequest
      focusRow(0)
    }
    const button =
      pendingFocus.current == null ? undefined : buttons.current.get(pendingFocus.current)
    if (button != null) {
      pendingFocus.current = null
      button.focus({ preventScroll: true })
    }
  })
  return (
    <div
      ref={scrollRef}
      className="gitna-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
      aria-label="Search results"
      onKeyDown={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
          'button[data-search-row]',
        )
        const index = rows.findIndex((row) => row.key === button?.dataset.searchRow)
        if (index < 0) return
        let next: number | undefined
        if (event.key === 'ArrowDown') next = Math.min(index + 1, rows.length - 1)
        if (event.key === 'ArrowUp') next = Math.max(index - 1, 0)
        if (event.key === 'Home') next = 0
        if (event.key === 'End') next = rows.length - 1
        if (next != null) {
          event.preventDefault()
          focusRow(next)
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onEscape()
        }
      }}
    >
      <div className="relative w-full text-xs" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          const { file, match } = row
          const collapsed = collapsedFiles.has(file.path)
          const separator = file.path.lastIndexOf('/')
          return (
            <button
              key={row.key}
              type="button"
              data-search-row={row.key}
              ref={(button) => {
                if (button) buttons.current.set(row.key, button)
                else buttons.current.delete(row.key)
              }}
              onFocus={() => setFocusedKey(row.key)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
              aria-expanded={match == null ? !collapsed : undefined}
              aria-label={match == null ? undefined : `Open ${file.path}:${match.line}`}
              aria-current={selectedMatch === row.key ? 'true' : undefined}
              onClick={() =>
                match == null
                  ? onToggle(file.path, !collapsed)
                  : onOpen(row.key, file.path, match.line, match.column)
              }
              onKeyDown={(event) => {
                if (match == null && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                  event.preventDefault()
                  onToggle(file.path, event.key === 'ArrowLeft')
                }
              }}
              className={cn(
                'flex w-full cursor-pointer items-center text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                match == null ? 'gap-1.5 px-3' : 'gap-2 overflow-hidden pl-10 pr-3',
                selectedMatch === row.key && 'bg-accent text-accent-foreground',
              )}
              title={
                match == null
                  ? file.path
                  : `${file.path}:${match.line}:${match.column + 1} — ${match.excerpt}`
              }
            >
              {match == null ? (
                <>
                  <IconChevronSm
                    aria-hidden="true"
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground',
                      collapsed && '-rotate-90',
                    )}
                  />
                  <FileTypeIcon path={file.path} />
                  <span className="truncate">{file.path.slice(separator + 1)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {file.path.slice(0, Math.max(0, separator))}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {file.matches.length}
                  </span>
                </>
              ) : (
                <>
                  <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">
                    {match.line}
                  </span>
                  <span className="min-w-0 truncate whitespace-pre font-mono text-xs">
                    {match.excerpt.slice(0, match.matchStart)}
                    <mark className="bg-[var(--gitna-search-match-bg)] text-[var(--gitna-search-match-fg)]">
                      {match.excerpt.slice(match.matchStart, match.matchEnd) || '\u200b'}
                    </mark>
                    {match.excerpt.slice(match.matchEnd)}
                  </span>
                </>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
