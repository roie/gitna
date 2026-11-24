import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button'
import { LoadingIndicator } from '../components/ui/loading'
import { Confirm } from '../components/modal'
import { message, type PendingConfirm } from '../components/tree-section'
import { Conversations, type ConversationsPane } from '../features/conversations/conversations'
import { Explorer } from '../features/explorer/explorer'
import { Graph } from '../features/graph/graph'
import {
  SourceControl,
  CHANGE_TREE_VIRTUALIZATION_THRESHOLD,
} from '../features/source-control/source-control'
import { cn } from '../lib/cn'
import { savePreference } from '../lib/preferences'
import { useRepository } from '../repository/repository'

const PANE_SIZES_STORAGE_KEY = 'gitna-source-control-pane-sizes-v2'
const DEFAULT_PANE_SIZES = [46, 26, 14, 14] as const
type PaneSizes = [number, number, number, number]
type PaneResizeIndex = 0 | 1 | 2

function readPaneSizes(): PaneSizes {
  try {
    const value = JSON.parse(localStorage.getItem(PANE_SIZES_STORAGE_KEY) ?? 'null') as unknown
    if (
      Array.isArray(value) &&
      (value.length === 3 || value.length === 4) &&
      value.every((entry) => typeof entry === 'number' && entry >= 8)
    ) {
      return [value[0], value[1], value[2], value[3] ?? DEFAULT_PANE_SIZES[3]]
    }
  } catch {
    // Invalid local state falls back to the stable VS Code-style proportions.
  }
  return [...DEFAULT_PANE_SIZES]
}

function usePaneSizes() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<PaneSizes>(readPaneSizes)
  const [customized, setCustomized] = useState(() => {
    try {
      return localStorage.getItem(PANE_SIZES_STORAGE_KEY) != null
    } catch {
      return false
    }
  })
  const resizeBy = useCallback((index: PaneResizeIndex, delta: number) => {
    setCustomized(true)
    setSizes((current) => {
      const next = [...current] as PaneSizes
      const bounded = Math.max(8 - current[index], Math.min(delta, current[index + 1] - 8))
      next[index] += bounded
      next[index + 1] -= bounded
      savePreference(PANE_SIZES_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])
  const startResize = useCallback(
    (index: PaneResizeIndex, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || containerRef.current == null) return
      event.preventDefault()
      const startY = event.clientY
      const startSizes = [...sizes] as PaneSizes
      setCustomized(true)
      const height = containerRef.current.getBoundingClientRect().height
      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = ((moveEvent.clientY - startY) / Math.max(1, height)) * 100
        const bounded = Math.max(8 - startSizes[index], Math.min(delta, startSizes[index + 1] - 8))
        const next = [...startSizes] as PaneSizes
        next[index] += bounded
        next[index + 1] -= bounded
        savePreference(PANE_SIZES_STORAGE_KEY, JSON.stringify(next))
        setSizes(next)
      }
      const stop = () => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', stop)
      }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', stop, { once: true })
    },
    [sizes],
  )
  return { containerRef, customized, resizeBy, sizes, startResize }
}

function PaneResizeHandle({
  disabled,
  index,
  onResize,
  onStart,
  size,
}: {
  disabled: boolean
  index: PaneResizeIndex
  onResize: (index: PaneResizeIndex, delta: number) => void
  onStart: (index: PaneResizeIndex, event: React.PointerEvent<HTMLElement>) => void
  size: number
}) {
  return (
    <hr
      aria-disabled={disabled}
      aria-label="Resize sidebar panes"
      aria-orientation="horizontal"
      aria-valuemax={92}
      aria-valuemin={8}
      aria-valuenow={Math.round(size)}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        'relative z-20 hidden h-0 overflow-visible border-0 outline-none before:absolute before:inset-x-0 before:-top-0.5 before:h-1 before:cursor-[ns-resize] before:bg-transparent before:transition-colors before:duration-100 hover:before:bg-[var(--ring)] focus-visible:before:bg-[var(--ring)] active:before:bg-[var(--ring)] md:block',
        disabled && 'pointer-events-none',
      )}
      onPointerDown={(event) => !disabled && onStart(index, event)}
      onKeyDown={(event) => {
        if (disabled || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        onResize(index, event.key === 'ArrowUp' ? -2 : 2)
      }}
    />
  )
}

function useObservedHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element == null) return
    const update = () => setHeight(Math.ceil(element.getBoundingClientRect().height))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  })
  return height
}

function useNaturalPaneHeight(
  paneRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const pane = paneRef.current
    const content = contentRef.current
    const header = pane?.firstElementChild
    if (pane == null || content == null || !(header instanceof HTMLElement)) return
    const children = [...content.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    )
    const update = () =>
      setHeight(
        Math.ceil(
          header.getBoundingClientRect().height +
            children.reduce((total, child) => total + child.getBoundingClientRect().height, 0),
        ),
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    for (const child of children) observer.observe(child)
    return () => observer.disconnect()
  })
  return height
}

export function Panes({
  active = true,
  conversations,
  onFindInFiles,
  onSearchCommits,
}: {
  active?: boolean
  conversations?: ConversationsPane
  onFindInFiles?: () => void
  onSearchCommits?: () => void
}) {
  const [commitMessage, setCommitMessage] = useState('')
  const [amend, setAmend] = useState(false)
  return active ? (
    <PanesInner
      conversations={conversations}
      onFindInFiles={onFindInFiles}
      onSearchCommits={onSearchCommits}
      commitMessage={commitMessage}
      setCommitMessage={setCommitMessage}
      amend={amend}
      setAmend={setAmend}
    />
  ) : null
}

function PanesInner({
  conversations,
  onFindInFiles,
  onSearchCommits,
  commitMessage,
  setCommitMessage,
  amend,
  setAmend,
}: {
  conversations?: ConversationsPane
  onFindInFiles?: () => void
  onSearchCommits?: () => void
  commitMessage: string
  setCommitMessage: (message: string) => void
  amend: boolean
  setAmend: (amend: boolean) => void
}) {
  const repository = useRepository()
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const conversationsPaneOpen = conversations != null && conversationsOpen
  const [workflowOpen, setWorkflowOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [graphOpen, setGraphOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const changesHeader = useRef<HTMLButtonElement>(null)
  const graphHeader = useRef<HTMLButtonElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const workflowPane = useRef<HTMLElement>(null)
  const workflowContent = useRef<HTMLDivElement>(null)
  const {
    containerRef,
    customized: paneSizesCustomized,
    resizeBy,
    sizes,
    startResize,
  } = usePaneSizes()
  const paneStackHeight = useObservedHeight(containerRef)
  const measuredWorkflowHeight = useNaturalPaneHeight(workflowPane, workflowContent)

  const snapshot = repository.snapshot
  const connectionHealthy = repository.connectionState === 'connected'
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const changedPathCount = new Set(
    [...staged, ...unstaged, ...(snapshot?.conflicts ?? [])].map((change) => change.path),
  ).size
  const workflowCompact = changedPathCount === 0 && repository.conflicts.length === 0
  const hasLargeOpenChangeSection =
    (stagedOpen && staged.length > CHANGE_TREE_VIRTUALIZATION_THRESHOLD) ||
    (changesOpen && unstaged.length > CHANGE_TREE_VIRTUALIZATION_THRESHOLD)
  const useNaturalWorkflowHeight =
    workflowOpen &&
    !workflowCompact &&
    (!hasLargeOpenChangeSection ||
      ((repositoryOpen || graphOpen || conversationsPaneOpen) && !paneSizesCustomized))
  const naturalWorkflowHeight = Math.min(
    measuredWorkflowHeight || 142,
    Math.max(142, (paneStackHeight * sizes[0]) / 100),
  )
  const workflowRow =
    !workflowOpen || workflowCompact
      ? 'max-content'
      : !repositoryOpen && !graphOpen && !conversationsPaneOpen
        ? 'minmax(142px, 1fr)'
        : useNaturalWorkflowHeight
          ? `${naturalWorkflowHeight}px`
          : `minmax(142px, ${sizes[0]}fr)`
  const selectedScope = repository.selection?.scope
  const selectedChangePath = repository.selection?.change.path

  const run = useCallback(async (action: () => Promise<void>) => {
    setLocalError(null)
    try {
      await action()
    } catch (error) {
      setLocalError(message(error))
    }
  }, [])

  const previousMutationErrorRef = useRef(repository.mutationError)
  useEffect(() => {
    if (
      repository.mutationError != null &&
      repository.mutationError !== previousMutationErrorRef.current
    ) {
      setLocalError(null)
    }
    previousMutationErrorRef.current = repository.mutationError
  }, [repository.mutationError])

  useEffect(() => {
    if (snapshot?.repository === false) setRepositoryOpen(true)
  }, [snapshot?.repository])

  useEffect(() => {
    if (repository.repositoryFileRevealVersion === 0) return
    setRepositoryOpen(true)
  }, [repository.repositoryFileRevealVersion])

  useEffect(() => {
    if (repository.graphReveal != null) setGraphOpen(true)
  }, [repository.graphReveal])

  useEffect(() => {
    if (selectedScope == null || selectedChangePath == null) return
    setWorkflowOpen(true)
    if (selectedScope === 'staged') setStagedOpen(true)
    else setChangesOpen(true)
  }, [selectedChangePath, selectedScope])

  useEffect(() => {
    if (snapshot?.repository === false) return
    if (window.matchMedia('(max-width: 767px)').matches) setGraphOpen(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F6') {
        event.preventDefault()
        if (event.shiftKey) {
          setGraphOpen(true)
          queueMicrotask(() => graphHeader.current?.focus())
        } else {
          setWorkflowOpen(true)
          setChangesOpen(true)
          queueMicrotask(() => changesHeader.current?.focus())
        }
      } else if (event.key.toLowerCase() === 'c' && event.ctrlKey && event.shiftKey) {
        event.preventDefault()
        setWorkflowOpen(true)
        queueMicrotask(() => composer.current?.focus())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [snapshot?.repository])

  if (snapshot == null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
        {connectionHealthy &&
          (repository.error ?? <LoadingIndicator>Loading repository…</LoadingIndicator>)}
      </div>
    )
  }

  return (
    <section
      className="source-control flex h-full min-h-0 flex-col"
      aria-label={snapshot.repository ? 'Source Control workflow' : 'File Explorer'}
    >
      <div
        ref={containerRef}
        className="pane-stack grid min-h-0 flex-1 overflow-hidden overscroll-contain max-md:block max-md:overflow-y-auto"
        style={{
          gridTemplateRows: [
            ...(snapshot.repository ? [workflowRow, '0'] : []),
            repositoryOpen ? `minmax(142px, ${sizes[1]}fr)` : 'max-content',
            ...(snapshot.repository
              ? ['0', graphOpen ? `minmax(142px, ${sizes[2]}fr)` : 'max-content']
              : []),
            ...(conversations == null
              ? []
              : ['0', conversationsOpen ? `minmax(142px, ${sizes[3]}fr)` : 'max-content']),
          ].join(' '),
        }}
      >
        {snapshot.repository && (
          <SourceControl
            snapshot={snapshot}
            commitMessage={commitMessage}
            setCommitMessage={setCommitMessage}
            amend={amend}
            setAmend={setAmend}
            changedPathCount={changedPathCount}
            workflowOpen={workflowOpen}
            onWorkflowOpenChange={setWorkflowOpen}
            changesOpen={changesOpen}
            onChangesOpenChange={setChangesOpen}
            stagedOpen={stagedOpen}
            onStagedOpenChange={setStagedOpen}
            changesHeader={changesHeader}
            composer={composer}
            workflowPane={workflowPane}
            workflowContent={workflowContent}
            onConfirm={setPendingConfirm}
            onError={setLocalError}
            run={run}
          />
        )}

        {snapshot.repository && (
          <PaneResizeHandle
            disabled={!workflowOpen || workflowCompact || !repositoryOpen}
            index={0}
            onResize={resizeBy}
            onStart={startResize}
            size={sizes[0]}
          />
        )}

        <Explorer
          snapshot={snapshot}
          open={repositoryOpen}
          onOpenChange={setRepositoryOpen}
          onFindInFiles={onFindInFiles}
          onError={setLocalError}
          run={run}
        />

        {snapshot.repository && (
          <PaneResizeHandle
            disabled={!repositoryOpen || !graphOpen}
            index={1}
            onResize={resizeBy}
            onStart={startResize}
            size={sizes[1]}
          />
        )}

        {snapshot.repository && (
          <Graph
            onSearchCommits={onSearchCommits}
            headerRef={graphHeader}
            scrollRootRef={containerRef}
            open={graphOpen}
            onConfirm={setPendingConfirm}
            onOpenChange={setGraphOpen}
          />
        )}

        {conversations != null && snapshot.repository && (
          <PaneResizeHandle
            disabled={!graphOpen || !conversationsOpen}
            index={2}
            onResize={resizeBy}
            onStart={startResize}
            size={sizes[2]}
          />
        )}

        {conversations != null && (
          <Conversations
            conversations={conversations}
            open={conversationsOpen}
            onOpenChange={setConversationsOpen}
          />
        )}
      </div>

      {repository.uncertainMutation != null && (
        <div
          className="mx-3 mb-3 rounded-md bg-warning/15 px-2.5 py-2 text-xs text-foreground"
          role="alert"
        >
          <p>{repository.uncertainMutation}</p>
          <Button
            className="mt-2"
            size="xs"
            variant="outline"
            onClick={() => repository.acknowledgeUncertainMutation()}
          >
            Acknowledge
          </Button>
        </div>
      )}
      {connectionHealthy && (localError ?? repository.mutationError) != null && (
        <p
          className="mx-3 mb-3 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          role="alert"
        >
          {localError ?? repository.mutationError}
        </p>
      )}

      {pendingConfirm != null && (
        <Confirm
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          disabledReason={repository.getActionDisabledReason()}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={async () => {
            const pending = pendingConfirm
            setPendingConfirm(null)
            await run(pending.run)
          }}
        />
      )}
    </section>
  )
}
