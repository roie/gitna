import { useEffect, useRef, useState, type ComponentProps } from 'react'
import {
  IconCollapsedRow,
  IconEllipsis,
  IconRefresh,
  IconRegex,
  IconSidebar,
  IconTypeWord,
  IconX,
} from '@pierre/icons'

import { ApiError, type ApiClient } from '../../lib/api'
import type { ContentSearchFile } from '../../lib/types'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { cn } from '../lib/cn'
import { FileTypeIconSprite } from './FileTypeIcon'
import { SearchResults } from './SearchResults'

interface FindInFilesPanelProps {
  api: ApiClient
  folderLabel: string
  active: boolean
  focusRequest: number
  onOpen(path: string, line: number, column: number): void
  onBack(): void
  onResultsChange(files: ContentSearchFile[]): void
}

function SearchButton({ children, className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        'size-6 text-xs text-muted-foreground hover:text-foreground aria-pressed:border-ring aria-pressed:bg-accent aria-pressed:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </Button>
  )
}

export function FindInFilesPanel({
  api,
  folderLabel,
  active,
  focusRequest,
  onOpen,
  onBack,
  onResultsChange,
}: FindInFilesPanelProps) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [files, setFiles] = useState<ContentSearchFile[]>([])
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchTick, setSearchTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [resultsFocusRequest, setResultsFocusRequest] = useState(0)
  const [skipped, setSkipped] = useState({ largeFiles: 0, longLines: 0 })

  useEffect(() => {
    onResultsChange(active ? files : [])
  }, [active, files, onResultsChange])

  useEffect(() => {
    if (!active) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [active, focusRequest])

  useEffect(() => {
    if (!active) return
    setFiles([])
    setError(null)
    setTruncated(false)
    setSkipped({ largeFiles: 0, longLines: 0 })
    setSelectedMatch(null)
    setLoading(query.length > 0)
    if (!query) return
    const controller = new AbortController()
    let timer: number
    let batchTimer: number | undefined
    let pendingFiles: ContentSearchFile[] = []
    const search = async () => {
      let firstBatch = true
      pendingFiles = []
      try {
        if (api.searchContent == null)
          throw new Error('Find in Files is unavailable for this session.')
        const result = await api.searchContent(query, {
          caseSensitive,
          regex: useRegex,
          wholeWord,
          includeIgnored,
          include,
          exclude,
          signal: controller.signal,
          onBatch: (batch) => {
            if (controller.signal.aborted) return
            pendingFiles = batch.results
            if (firstBatch) {
              firstBatch = false
              setFiles(batch.results)
              return
            }
            // Paint the first match immediately; coalesce later frames so
            // sidebar/highlight updates do not rerender the whole workbench per file.
            batchTimer ??= window.setTimeout(() => {
              batchTimer = undefined
              if (!controller.signal.aborted) setFiles(pendingFiles)
            }, 100)
          },
        })
        if (controller.signal.aborted) return
        window.clearTimeout(batchTimer)
        batchTimer = undefined
        setFiles(result.results)
        setTruncated(result.truncated)
        setSkipped({
          largeFiles: result.skippedLargeFiles ?? 0,
          longLines: result.skippedLongLines ?? 0,
        })
        setLoading(!result.complete && !result.truncated)
        if (!result.complete && !result.truncated)
          timer = window.setTimeout(() => void search(), 350)
      } catch (reason) {
        if (controller.signal.aborted) return
        window.clearTimeout(batchTimer)
        batchTimer = undefined
        if (reason instanceof ApiError && reason.status === 504) {
          setFiles(pendingFiles)
          setError(
            firstBatch
              ? 'Search timed out. Narrow the search and try again.'
              : 'Search timed out. Partial results are shown; narrow the search and try again.',
          )
        } else {
          setError(reason instanceof Error ? reason.message : String(reason))
          setFiles([])
        }
        setLoading(false)
      }
    }
    timer = window.setTimeout(() => void search(), 100)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(batchTimer)
      controller.abort()
    }
  }, [
    active,
    api,
    caseSensitive,
    exclude,
    include,
    includeIgnored,
    query,
    searchTick,
    useRegex,
    wholeWord,
  ])

  const matchCount = files.reduce((total, file) => total + file.matches.length, 0)
  const allCollapsed = files.length > 0 && files.every((file) => collapsedFiles.has(file.path))
  const toggleFile = (path: string, collapse: boolean) =>
    setCollapsedFiles((current) => {
      const next = new Set(current)
      if (collapse) next.add(path)
      else next.delete(path)
      return next
    })

  return (
    <section
      className={cn('h-full min-h-0 flex-col', active ? 'flex' : 'hidden')}
      aria-label="Find in Files"
    >
      <FileTypeIconSprite />
      <div className="shrink-0 px-3 pb-2">
        <div className="flex h-9 items-center justify-between gap-2">
          <h2 className="text-xs font-medium">Search</h2>
          <div className="flex items-center gap-0.5">
            <SearchButton
              aria-label="Refresh search"
              title="Refresh search"
              disabled={!query || loading}
              onClick={() => setSearchTick((tick) => tick + 1)}
            >
              <IconRefresh aria-hidden="true" className="size-3.5" />
            </SearchButton>
            <SearchButton
              aria-label="Clear search"
              title="Clear search"
              disabled={!query}
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            >
              <IconX aria-hidden="true" className="size-3.5" />
            </SearchButton>
            <SearchButton
              aria-label={allCollapsed ? 'Expand all results' : 'Collapse all results'}
              title={allCollapsed ? 'Expand all results' : 'Collapse all results'}
              disabled={files.length === 0}
              onClick={() =>
                setCollapsedFiles(
                  allCollapsed ? new Set() : new Set(files.map((file) => file.path)),
                )
              }
            >
              <IconCollapsedRow aria-hidden="true" className="size-3.5" />
            </SearchButton>
            <SearchButton
              aria-label="Show Source Control"
              title="Show Source Control"
              onClick={onBack}
            >
              <IconSidebar aria-hidden="true" className="size-3.5" />
            </SearchButton>
          </div>
        </div>
        <div className="relative">
          <Input
            ref={inputRef}
            inputSize="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                setSearchTick((tick) => tick + 1)
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setResultsFocusRequest((request) => request + 1)
              }
            }}
            placeholder="Search"
            aria-label="Search files"
            aria-invalid={error != null}
            aria-describedby={error ? 'find-in-files-error' : undefined}
            autoComplete="off"
            spellCheck={false}
            className="bg-background pr-20 text-base md:text-xs"
          />
          <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
            <SearchButton
              onClick={() => setCaseSensitive((value) => !value)}
              aria-pressed={caseSensitive}
              aria-label="Match case"
              title="Match case"
            >
              Aa
            </SearchButton>
            <SearchButton
              onClick={() => setWholeWord((value) => !value)}
              aria-pressed={wholeWord}
              aria-label="Match whole word"
              title="Match whole word"
            >
              <IconTypeWord aria-hidden="true" className="size-3.5" />
            </SearchButton>
            <SearchButton
              onClick={() => setUseRegex((value) => !value)}
              aria-pressed={useRegex}
              aria-label="Use regular expression"
              title="Use regular expression"
            >
              <IconRegex aria-hidden="true" className="size-3.5" />
            </SearchButton>
          </div>
        </div>
        <div className="mt-1 flex min-h-6 items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground" title={folderLabel}>
            {include || exclude || includeIgnored ? 'Search filters active' : ''}
          </span>
          <SearchButton
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls="find-in-files-details"
            aria-label="Toggle Search Details"
            title="Toggle Search Details"
          >
            <IconEllipsis aria-hidden="true" className="size-3.5" />
          </SearchButton>
        </div>
        {detailsOpen && (
          <div id="find-in-files-details" className="space-y-2 pb-1">
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Files to include</span>
              <Input
                inputSize="sm"
                value={include}
                onChange={(event) => setInclude(event.target.value)}
                placeholder="e.g. src/**, *.ts"
                className="bg-background text-base text-foreground md:text-xs"
              />
            </label>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Files to exclude</span>
              <Input
                inputSize="sm"
                value={exclude}
                onChange={(event) => setExclude(event.target.value)}
                placeholder="e.g. **/node_modules/**"
                className="bg-background text-base text-foreground md:text-xs"
              />
            </label>
            <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={!includeIgnored}
                onChange={(event) => setIncludeIgnored(!event.target.checked)}
                className="accent-[var(--diffshub-primary-fg)]"
              />
              Use ignore files
            </label>
          </div>
        )}
        <p role="status" className="pt-1 text-xs text-muted-foreground">
          {!query
            ? `Search in ${folderLabel}.`
            : error
              ? ''
              : loading
                ? 'Searching…'
                : matchCount === 0
                  ? skipped.largeFiles > 0 || skipped.longLines > 0
                    ? 'No matches in searched text.'
                    : 'No results found.'
                  : `${matchCount} ${matchCount === 1 ? 'result' : 'results'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
        </p>
        {error && (
          <p
            id="find-in-files-error"
            role="alert"
            className="break-words pt-1 text-xs text-destructive"
          >
            {error}
          </p>
        )}
      </div>
      {(skipped.largeFiles > 0 || skipped.longLines > 0) && (
        <p role="status" className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
          Search coverage is incomplete. Skipped {skipped.largeFiles}{' '}
          {skipped.largeFiles === 1 ? 'file' : 'files'} larger than 512 KiB and {skipped.longLines}{' '}
          {skipped.longLines === 1 ? 'line' : 'lines'} longer than 64 KiB.
        </p>
      )}
      {truncated && (
        <p className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
          Showing the first {matchCount} results. Narrow your search to see more.
        </p>
      )}
      <SearchResults
        files={files}
        collapsedFiles={collapsedFiles}
        selectedMatch={selectedMatch}
        active={active}
        focusRequest={resultsFocusRequest}
        onToggle={toggleFile}
        onEscape={() => inputRef.current?.focus()}
        onOpen={(key, path, line, column) => {
          setSelectedMatch(key)
          onOpen(path, line, column)
        }}
      />
    </section>
  )
}
