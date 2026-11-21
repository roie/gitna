import { IconBranch, IconEllipsis, IconRefresh } from '@pierre/icons'
import { type Range, useVirtualizer } from '@tanstack/react-virtual'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { GraphRow } from '../../lib/graph-lanes'
import type { CommitFile } from '../../lib/types'
import { Button } from '../components/Button'
import { CHROME_ICON_BUTTON_CLASS } from '../components/chromeButtonStyles'
import type { FileTree, FileTreeDirectoryHandle } from '@pierre/trees'
import { Tree } from './Tree'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/DropdownMenu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/Tooltip'
import { cn } from '../lib/cn'
import { LoadingIndicator, useLoadingIndicator } from '../lib/loading'
import {
  graphRangeExtractor,
  nextGraphFocusIndex,
  shouldLoadMoreGraph,
} from './graphVirtualization'
import { CommitTooltip } from './CommitTooltip'
import { useRepository } from './repository'
import { Header } from './ui/Header'
import { Pane } from './ui/Pane'
import { Row } from './ui/Row'
import {
  type PendingConfirm,
  type RepositoryViewMode,
  createRepositoryListSource,
  createTreeSource,
} from './panes'

interface GraphProps {
  onSearchCommits?: () => void
  headerRef: React.RefObject<HTMLButtonElement | null>
  scrollRootRef: React.RefObject<HTMLDivElement | null>
  onConfirm: (confirm: PendingConfirm) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}

const GRAPH_LANE_SPACING = 12
const GRAPH_LANE_INSET = 8
const GRAPH_ROW_HEIGHT = 28
const GRAPH_LANE_COLORS = [1, 2, 3, 4, 5].map((lane) => `var(--gitna-lane-${lane})`)

function graphColumnX(column: number): number {
  return GRAPH_LANE_INSET + column * GRAPH_LANE_SPACING
}

function graphLaneColor(column: number): string {
  return GRAPH_LANE_COLORS[column % GRAPH_LANE_COLORS.length]!
}

type GraphTreeExpansionCache = WeakMap<
  readonly CommitFile[],
  Partial<Record<RepositoryViewMode, readonly string[]>>
>

type GraphPinReason = 'menu' | 'tooltip'

interface GraphScrollAnchor {
  index: number
  offset: number
  oid: string
}

export function Graph({
  onSearchCommits,
  headerRef,
  scrollRootRef,
  onConfirm,
  onOpenChange,
  open,
}: GraphProps) {
  const repository = useRepository()
  const [view, setView] = useState<RepositoryViewMode>('tree')
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pins, setPins] = useState<ReadonlySet<string>>(() => new Set())
  const graphBodyRef = useRef<HTMLDivElement>(null)
  const [treeExpansionCache] = useState<GraphTreeExpansionCache>(() => new WeakMap())
  const continuationArmedRef = useRef(false)
  const revealedRef = useRef<typeof repository.graphReveal>(null)
  const anchorRef = useRef<GraphScrollAnchor | null>(null)
  const previousRowsRef = useRef<readonly string[]>([])
  const laneCount = Math.max(1, ...repository.graphRows.map((row) => row.totalColumns))
  const pinnedIndices = useMemo(() => {
    const indices = new Set<number>()
    if (repository.graphRows[activeIndex] != null) indices.add(activeIndex)
    for (const pin of pins) {
      const oid = pin.slice(pin.indexOf(':') + 1)
      const index = repository.graphRows.findIndex((row) => row.commit.oid === oid)
      if (index >= 0) indices.add(index)
    }
    return [...indices]
  }, [activeIndex, pins, repository.graphRows])
  const rangeExtractor = useCallback(
    (range: Range) => graphRangeExtractor(range, pinnedIndices),
    [pinnedIndices],
  )
  const virtualizer = useVirtualizer({
    count: repository.graphRows.length,
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
    enabled: open,
    estimateSize: () => GRAPH_ROW_HEIGHT + 8,
    getItemKey: (index) => repository.graphRows[index]?.commit.oid ?? index,
    getScrollElement: () => (mobile ? scrollRootRef.current : graphBodyRef.current),
    onChange(instance) {
      const previousRows = previousRowsRef.current
      if (
        previousRows.length !== repository.graphRows.length ||
        previousRows[0] !== repository.graphRows[0]?.commit.oid
      ) {
        return
      }
      const scrollOffset = instance.scrollOffset ?? 0
      const item = instance.getVirtualItems().find((candidate) => candidate.end > scrollOffset)
      const oid =
        item == null
          ? undefined
          : (previousRowsRef.current[item.index] ?? repository.graphRows[item.index]?.commit.oid)
      if (item != null && oid != null) {
        anchorRef.current = {
          index: item.index,
          offset: scrollOffset - item.start,
          oid,
        }
      }
    },
    overscan: 2,
    rangeExtractor,
    scrollMargin,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const graphCount = repository.graphTotal == null ? null : `${repository.graphTotal}`
  const graphRefreshing = repository.graphLoading || repository.graphCountLoading
  const graphRefreshVisible = useLoadingIndicator(graphRefreshing)
  const graphSetSize =
    repository.graphTotal ?? (repository.graphHasMore ? -1 : repository.graphRows.length)
  const armContinuation = useCallback(() => {
    continuationArmedRef.current = true
  }, [])

  useEffect(() => {
    if (
      !open ||
      !continuationArmedRef.current ||
      repository.graphLoading ||
      repository.graphError != null ||
      !repository.graphHasMore
    ) {
      return
    }
    const lastVisible = virtualizer.range?.endIndex ?? -1
    if (!shouldLoadMoreGraph(lastVisible, repository.graphRows.length)) return
    continuationArmedRef.current = false
    void repository.loadMoreGraph()
  }, [
    open,
    repository,
    repository.graphError,
    repository.graphHasMore,
    repository.graphLoading,
    repository.graphRows.length,
    virtualItems,
  ])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (!open || !mobile) {
      setScrollMargin(0)
      return
    }
    const body = graphBodyRef.current
    const root = scrollRootRef.current
    if (body == null || root == null) return
    const update = () => {
      const bodyBox = body.getBoundingClientRect()
      const rootBox = root.getBoundingClientRect()
      setScrollMargin(Math.round(bodyBox.top - rootBox.top + root.scrollTop))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(body)
    observer.observe(root)
    for (const pane of root.querySelectorAll<HTMLElement>('[data-pane]')) observer.observe(pane)
    return () => observer.disconnect()
  }, [mobile, open, scrollRootRef])

  useLayoutEffect(() => {
    const rows = repository.graphRows.map((row) => row.commit.oid)
    const previousRows = previousRowsRef.current
    const anchor = anchorRef.current
    if (anchor != null && previousRows.length > 0) {
      const previousIndex = previousRows.indexOf(anchor.oid)
      const nextIndex = rows.indexOf(anchor.oid)
      if (previousIndex >= 0 && nextIndex >= 0) {
        virtualizer.scrollToIndex(nextIndex, { align: 'start' })
        requestAnimationFrame(() => {
          const item = virtualizer
            .getVirtualItems()
            .find((candidate) => candidate.index === nextIndex)
          if (item != null) virtualizer.scrollToOffset(item.start + anchor.offset)
        })
      }
    }
    const activeOid = previousRows[activeIndex]
    if (activeOid != null) {
      const nextActiveIndex = rows.indexOf(activeOid)
      setActiveIndex(nextActiveIndex >= 0 ? nextActiveIndex : 0)
    } else if (activeIndex >= rows.length) {
      setActiveIndex(Math.max(0, rows.length - 1))
    }
    previousRowsRef.current = rows
  }, [repository.graphRows])

  const setPinned = useCallback((oid: string, reason: GraphPinReason, pinned: boolean) => {
    const key = `${reason}:${oid}`
    setPins((current) => {
      const next = new Set(current)
      if (pinned) next.add(key)
      else next.delete(key)
      return next.size === current.size && [...next].every((value) => current.has(value))
        ? current
        : next
    })
  }, [])

  const focusIndex = useCallback(
    (index: number) => {
      setActiveIndex(index)
      virtualizer.scrollToIndex(index, { align: 'auto' })
      let attempts = 0
      const focus = () => {
        const disclosure = graphBodyRef.current?.querySelector<HTMLButtonElement>(
          `[data-graph-index="${index}"] [data-graph-disclosure]`,
        )
        if (disclosure != null) {
          disclosure.focus()
          return
        }
        attempts += 1
        if (attempts < 20) requestAnimationFrame(focus)
      }
      requestAnimationFrame(focus)
    },
    [virtualizer],
  )
  useEffect(() => {
    const reveal = repository.graphReveal
    if (!open || reveal == null || revealedRef.current === reveal || repository.graphLoading) return
    const index = repository.graphRows.findIndex((row) => row.commit.oid === reveal.oid)
    if (index >= 0) {
      revealedRef.current = reveal
      continuationArmedRef.current = false
      focusIndex(index)
    } else if (repository.graphHasMore && repository.graphError == null) {
      void repository.loadMoreGraph()
    }
  }, [
    open,
    repository.graphReveal,
    repository.graphRows,
    repository.graphLoading,
    repository.graphHasMore,
    repository.graphError,
    focusIndex,
    repository,
  ])

  const handleDisclosureFocus = useCallback((index: number) => setActiveIndex(index), [])
  const handleDisclosureKeyDown = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
      const next = nextGraphFocusIndex(index, event.key, repository.graphRows.length)
      if (next == null || next === index) return
      event.preventDefault()
      focusIndex(next)
    },
    [focusIndex, repository.graphRows.length],
  )
  const handlePinChange = useCallback(
    (oid: string, reason: GraphPinReason, pinned: boolean) => setPinned(oid, reason, pinned),
    [setPinned],
  )

  return (
    <section data-pane="graph" className="section min-h-0 overflow-hidden md:flex md:flex-col">
      <Header
        level="pane"
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-only"
              aria-label={graphRefreshing ? 'Refreshing Graph' : 'Refresh Graph'}
              title={graphRefreshing ? 'Refreshing Graph' : 'Refresh Graph'}
              className={CHROME_ICON_BUTTON_CLASS}
              disabled={graphRefreshing}
              onClick={() => void repository.refreshGraph()}
            >
              <IconRefresh
                className={cn(
                  'size-4 motion-reduce:animate-none md:size-3',
                  graphRefreshVisible && 'animate-spin',
                )}
              />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-only"
                  aria-label="Graph actions"
                  data-menu-focus-fallback
                  title="Graph actions"
                  className={CHROME_ICON_BUTTON_CLASS}
                >
                  <IconEllipsis className="size-4 md:size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem selected={view === 'tree'} onSelect={() => setView('tree')}>
                  Show as Tree
                </DropdownMenuItem>
                <DropdownMenuItem selected={view === 'list'} onSelect={() => setView('list')}>
                  Show as List
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={
                    !repository.graphRows.some((row) => !repository.expanded[row.commit.oid])
                  }
                  onSelect={() => repository.expandLoadedCommits()}
                >
                  Expand loaded commits
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!Object.values(repository.expanded).some(Boolean)}
                  onSelect={() => repository.collapseAllCommits()}
                >
                  Collapse all
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {onSearchCommits != null && (
                  <DropdownMenuItem onSelect={onSearchCommits}>Search Commits…</DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={!repository.graphHasMore || repository.graphLoading}
                  onSelect={() => void repository.loadMoreGraph()}
                >
                  Load more commits
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        count={graphCount}
        countTitle={
          graphCount == null
            ? repository.graphCountLoading
              ? 'Counting commits in Graph'
              : undefined
            : `${graphCount} commits in Graph`
        }
        dataSection="graph"
        ref={headerRef}
        icon={IconBranch}
        open={open}
        title="Graph"
        onOpenChange={onOpenChange}
      />
      {open && (
        <TooltipProvider delayDuration={500} skipDelayDuration={150}>
          <Pane
            ref={graphBodyRef}
            data-pane-body="graph"
            className="graph-list min-h-0 px-2 pb-4 md:flex-1 max-md:overflow-visible"
            onKeyDownCapture={(event) => {
              if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) armContinuation()
            }}
            onTouchStart={armContinuation}
            onWheel={armContinuation}
          >
            <div
              ref={virtualizer.containerRef}
              role="list"
              aria-label="Commits"
              aria-busy={repository.graphLoading || undefined}
              data-graph-virtual-list
              className="relative w-full"
            >
              {virtualItems.map((item) => {
                const row = repository.graphRows[item.index]
                if (row == null) return null
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    role="listitem"
                    aria-posinset={item.index + 1}
                    aria-setsize={graphSetSize}
                    className="graph-row absolute top-0 left-0 w-full"
                    data-graph-index={item.index}
                    data-graph-oid={row.commit.oid}
                    data-index={item.index}
                  >
                    <CommitRow
                      disclosureTabIndex={item.index === activeIndex ? 0 : -1}
                      index={item.index}
                      laneCount={laneCount}
                      treeExpansionCache={treeExpansionCache}
                      row={row}
                      view={view}
                      onConfirm={onConfirm}
                      onDisclosureFocus={handleDisclosureFocus}
                      onDisclosureKeyDown={handleDisclosureKeyDown}
                      onPinChange={handlePinChange}
                    />
                  </div>
                )
              })}
            </div>
            {repository.graphLoading && repository.graphRows.length > 0 && (
              <LoadingIndicator>
                <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                  Loading more commits…
                </p>
              </LoadingIndicator>
            )}
            {repository.connectionState === 'connected' && repository.graphError != null && (
              <div className="space-y-1 px-2 py-2">
                <p role="alert" className="text-xs text-destructive">
                  {repository.graphError}
                </p>
                {repository.graphHasMore && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={repository.graphLoading}
                    onClick={() => void repository.loadMoreGraph()}
                  >
                    Retry loading commits
                  </Button>
                )}
              </div>
            )}
          </Pane>
        </TooltipProvider>
      )}
    </section>
  )
}

function Lanes({ laneCount, open, row }: { laneCount: number; open: boolean; row: GraphRow }) {
  const width = graphColumnX(laneCount - 1) + GRAPH_LANE_INSET
  const nodeX = graphColumnX(row.column)
  const middle = GRAPH_ROW_HEIGHT / 2
  return (
    <svg
      aria-hidden="true"
      data-graph-gutter
      className="h-7 shrink-0"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
    >
      {row.lanes.map((lane) => {
        const laneX = graphColumnX(lane.column)
        const color = graphLaneColor(lane.column)
        return lane.next === row.commit.oid ? (
          <path
            key={`incoming:${lane.column}`}
            data-graph-segment
            d={`M ${laneX} 0 C ${laneX} ${middle / 2}, ${nodeX} ${middle / 2}, ${nodeX} ${middle}`}
            fill="none"
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <line
            key={`passing:${lane.column}`}
            data-graph-segment
            x1={laneX}
            x2={laneX}
            y1="0"
            y2={GRAPH_ROW_HEIGHT}
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
      {row.outgoing.map((column) => {
        const outgoingX = graphColumnX(column)
        return column === row.column ? (
          <line
            key={`outgoing:${column}`}
            data-graph-segment
            x1={nodeX}
            x2={nodeX}
            y1={middle}
            y2={GRAPH_ROW_HEIGHT}
            stroke={graphLaneColor(column)}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <path
            key={`outgoing:${column}`}
            data-graph-segment
            d={`M ${nodeX} ${middle} C ${nodeX} ${middle + middle / 2}, ${outgoingX} ${middle + middle / 2}, ${outgoingX} ${GRAPH_ROW_HEIGHT}`}
            fill="none"
            stroke={graphLaneColor(column)}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
      <circle
        data-graph-node
        cx={nodeX}
        cy={middle}
        r="4"
        fill={
          open ? graphLaneColor(row.column) : 'var(--diffshub-sidebar-bg, var(--color-background))'
        }
        stroke={graphLaneColor(row.column)}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

const CommitRow = memo(function CommitRow({
  treeExpansionCache,
  disclosureTabIndex,
  index,
  laneCount,
  row,
  view,
  onConfirm,
  onDisclosureFocus,
  onDisclosureKeyDown,
  onPinChange,
}: {
  treeExpansionCache: GraphTreeExpansionCache
  disclosureTabIndex: number
  index: number
  laneCount: number
  row: GraphRow
  view: RepositoryViewMode
  onConfirm: (confirm: PendingConfirm) => void
  onDisclosureFocus: (index: number) => void
  onDisclosureKeyDown: (index: number, event: ReactKeyboardEvent<HTMLElement>) => void
  onPinChange: (oid: string, reason: GraphPinReason, pinned: boolean) => void
}) {
  const repository = useRepository()
  const open = repository.expanded[row.commit.oid] === true
  const shortOid = row.commit.oid.slice(0, 8)
  const disabledReason = repository.getActionDisabledReason()
  const files = repository.commitFiles[row.commit.oid]
  const filesLoading = repository.filesLoading[row.commit.oid] === true
  const filesLoadingVisible = useLoadingIndicator(open && filesLoading, row.commit.oid)
  useEffect(() => {
    if (open) void repository.loadCommitDetails(row.commit.oid)
  }, [open, repository, row.commit.oid])
  const stats = repository.commitStats[row.commit.oid]
  const source = useMemo(
    () =>
      view === 'tree'
        ? createTreeSource(files ?? [])
        : createRepositoryListSource(
            (files ?? []).map((file) => file.path),
            files ?? [],
            new Set(),
          ),
    [files, view],
  )
  const initialExpandedPaths = files == null ? undefined : treeExpansionCache.get(files)?.[view]
  const saveExpandedPaths = useCallback(
    (paths: readonly string[]) => {
      if (files == null) return
      const cached = treeExpansionCache.get(files) ?? {}
      cached[view] = paths
      treeExpansionCache.set(files, cached)
    },
    [files, treeExpansionCache, view],
  )
  const [treeModel, setTreeModel] = useState<FileTree | null>(null)
  const [treeHeight, setTreeHeight] = useState(0)
  const directoryPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const path of source.paths) {
      for (
        let separator = path.indexOf('/');
        separator >= 0;
        separator = path.indexOf('/', separator + 1)
      ) {
        paths.add(path.slice(0, separator + 1))
      }
    }
    return [...paths]
  }, [source])
  useLayoutEffect(() => {
    if (treeModel == null) return
    const publish = () => {
      setTreeHeight(treeModel.getVisibleCount() * treeModel.getItemHeight())
      saveExpandedPaths(
        directoryPaths.filter((path) => {
          const item = treeModel.getItem(path)
          return item?.isDirectory() && (item as FileTreeDirectoryHandle).isExpanded()
        }),
      )
    }
    publish()
    return treeModel.subscribe(publish)
  }, [directoryPaths, saveExpandedPaths, treeModel])
  const selectedPath =
    repository.commitDiff?.oid === row.commit.oid ? repository.commitDiff.path : null
  const refs = row.commit.refs.filter(
    (ref, index, all) => all.findIndex((candidate) => candidate.name === ref.name) === index,
  )
  const visibleRefs = refs.slice(0, 2)
  return (
    <div
      className="graph-row-content"
      onKeyDownCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-graph-disclosure]') != null) {
          onDisclosureKeyDown(index, event)
        }
      }}
    >
      <Tooltip
        onOpenChange={(tooltipOpen) => {
          onPinChange(row.commit.oid, 'tooltip', tooltipOpen)
          if (tooltipOpen) void repository.loadCommitDetails(row.commit.oid)
        }}
      >
        <TooltipTrigger asChild>
          <Row
            className="relative gap-1 px-1 [&>button]:gap-1"
            selected={open}
            id={`gitna-graph-disclosure-${row.commit.oid}`}
            data-graph-disclosure
            aria-controls={`gitna-graph-files-${row.commit.oid}`}
            aria-expanded={open}
            tabIndex={disclosureTabIndex}
            onClick={() => void repository.toggleCommit(row.commit.oid)}
            onFocus={() => onDisclosureFocus(index)}
            icon={<Lanes laneCount={laneCount} open={open} row={row} />}
            label={
              <span className="font-medium">
                {row.commit.subject.trim() || `No commit message (${row.commit.oid.slice(0, 7)})`}
              </span>
            }
            status={
              <>
                {visibleRefs.map((ref) => (
                  <span
                    key={`${ref.kind}:${ref.name}`}
                    className={cn(
                      'max-w-24 shrink-0 truncate rounded-full border border-highlight/60 px-1.5 py-0.5 text-[11px] leading-none',
                      ref.kind === 'head'
                        ? 'bg-highlight text-background'
                        : 'bg-highlight/10 text-highlight',
                    )}
                  >
                    {ref.name}
                  </span>
                ))}
                {refs.length > visibleRefs.length && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    +{refs.length - visibleRefs.length}
                  </span>
                )}
              </>
            }
            actions={
              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-e-md bg-linear-to-l from-accent from-60% to-transparent ps-4 pe-1 opacity-0 group-hover/row:opacity-100 has-focus-visible:opacity-100 has-data-[state=open]:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:bg-none [@media(hover:none)]:p-0 [@media(hover:none)]:opacity-100">
                <DropdownMenu
                  onOpenChange={(menuOpen) => {
                    if (menuOpen) onDisclosureFocus(index)
                    onPinChange(row.commit.oid, 'menu', menuOpen)
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-only"
                      className="pointer-events-auto"
                      aria-label={`Actions for ${row.commit.subject.trim() || row.commit.oid.slice(0, 7)}`}
                      title={`Actions for ${row.commit.subject.trim() || row.commit.oid.slice(0, 7)}`}
                    >
                      <IconEllipsis className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={disabledReason != null}
                      onSelect={() =>
                        void repository
                          .operation({ op: 'cherry-pick', ref: row.commit.oid })
                          .catch(() => {
                            // The store has already published the mutation error.
                          })
                      }
                    >
                      Cherry-pick
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={disabledReason != null}
                      onSelect={() =>
                        void repository
                          .operation({ op: 'revert', ref: row.commit.oid })
                          .catch(() => {
                            // The store has already published the mutation error.
                          })
                      }
                    >
                      Revert
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={disabledReason != null}
                      onSelect={() =>
                        void repository
                          .operation({ op: 'reset', ref: row.commit.oid, mode: 'soft' })
                          .catch(() => {
                            // The store has already published the mutation error.
                          })
                      }
                    >
                      Reset soft
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={disabledReason != null}
                      onSelect={() =>
                        void repository
                          .operation({ op: 'reset', ref: row.commit.oid, mode: 'mixed' })
                          .catch(() => {
                            // The store has already published the mutation error.
                          })
                      }
                    >
                      Reset mixed
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={disabledReason != null}
                      onSelect={() =>
                        onConfirm({
                          title: `Hard reset to ${shortOid}?`,
                          message:
                            'This discards index and working-tree changes. Gitna cannot undo this action.',
                          confirmLabel: 'Hard reset',
                          run: () =>
                            repository.operation({
                              op: 'reset',
                              ref: row.commit.oid,
                              mode: 'hard',
                            }),
                        })
                      }
                    >
                      Reset hard…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            }
          />
        </TooltipTrigger>
        <TooltipContent side="right" align="start">
          <CommitTooltip
            commit={row.commit}
            stats={stats}
            error={repository.filesError[row.commit.oid]}
          />
        </TooltipContent>
      </Tooltip>
      {open && (
        <div
          id={`gitna-graph-files-${row.commit.oid}`}
          data-graph-files
          aria-labelledby={`gitna-graph-disclosure-${row.commit.oid}`}
          className="border-l-2 pl-1"
          style={{
            borderColor: graphLaneColor(row.column),
            marginLeft: graphColumnX(row.column) + 3,
          }}
        >
          {filesLoading && filesLoadingVisible && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          )}
          {files != null && files.length > 0 && (
            <Tree
              key={view}
              className="overscroll-auto md:ml-1"
              style={{ height: treeHeight }}
              options={{
                id: `gitna-graph-${row.commit.oid}`,
                ...(initialExpandedPaths == null
                  ? {}
                  : { initialExpansion: 'closed', initialExpandedPaths }),
              }}
              onModelReady={setTreeModel}
              onSelectItem={(path) => {
                const file = files.find((candidate) => candidate.path === path)
                if (file != null) {
                  repository.selectCommitFile(row.commit.oid, row.commit.subject, file)
                }
              }}
              selectedPath={selectedPath}
              source={source}
            />
          )}
          {files != null && files.length === 0 && !repository.filesLoading[row.commit.oid] && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No changed files</p>
          )}
          {repository.connectionState === 'connected' &&
            repository.filesError[row.commit.oid] != null && (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {repository.filesError[row.commit.oid]}
              </p>
            )}
        </div>
      )}
    </div>
  )
})
