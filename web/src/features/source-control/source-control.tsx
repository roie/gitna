import { IconRefresh, IconSymbolDiffstatFill } from '@pierre/icons'
import { useCallback, useMemo, useRef, useState } from 'react'
import { message, type PendingConfirm } from '../../components/tree-section'
import { Button } from '../../components/ui/button'
import { Header } from '../../components/ui/header'
import { useLoadingIndicator } from '../../components/ui/loading'
import { Pane } from '../../components/ui/pane'
import { Switch } from '../../components/ui/switch'
import { cn } from '../../lib/cn'
import { createTreeSource } from '../../lib/tree-files'
import { useRepository } from '../../repository/repository-provider'
import { ChangeSection } from './change-section'
import { Conflicts } from './conflicts'
import { SourceControlHeaderActions } from './header-actions'
import { OperationModal, type OperationDialog } from './operation-modal'

export function SourceControl({
  snapshot,
  commitMessage,
  setCommitMessage,
  amend,
  setAmend,
  changedPathCount,
  workflowOpen,
  onWorkflowOpenChange: setWorkflowOpen,
  changesOpen,
  onChangesOpenChange: setChangesOpen,
  stagedOpen,
  onStagedOpenChange: setStagedOpen,
  changesHeader,
  composer,
  workflowPane,
  workflowContent,
  onConfirm: setPendingConfirm,
  onError: setLocalError,
  run,
}: {
  snapshot: NonNullable<ReturnType<typeof useRepository>['snapshot']>
  commitMessage: string
  setCommitMessage: (message: string) => void
  amend: boolean
  setAmend: (amend: boolean) => void
  changedPathCount: number
  workflowOpen: boolean
  onWorkflowOpenChange: (open: boolean) => void
  changesOpen: boolean
  onChangesOpenChange: (open: boolean) => void
  stagedOpen: boolean
  onStagedOpenChange: (open: boolean) => void
  changesHeader: React.RefObject<HTMLButtonElement | null>
  composer: React.RefObject<HTMLTextAreaElement | null>
  workflowPane: React.RefObject<HTMLElement | null>
  workflowContent: React.RefObject<HTMLDivElement | null>
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const repository = useRepository()
  const [operationDialog, setOperationDialog] = useState<OperationDialog>(null)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const staged = snapshot?.staged ?? []
  const unstaged = snapshot?.unstaged ?? []
  const workflowRefreshVisible = useLoadingIndicator(repository.loading)
  const headTitle =
    snapshot?.headBranch ??
    (snapshot?.headOid == null ? 'Detached HEAD' : `Detached at ${snapshot.headOid.slice(0, 8)}`)
  const workflowChangedDescription =
    changedPathCount > 0
      ? `${changedPathCount} changed ${changedPathCount === 1 ? 'file' : 'files'}`
      : null
  let workflowCountLabel: string | undefined
  let workflowCountTitle: string | undefined
  if (workflowRefreshVisible) {
    workflowCountLabel = workflowChangedDescription
      ? `${workflowChangedDescription}, refreshing Source Control`
      : 'Refreshing Source Control'
    workflowCountTitle = workflowChangedDescription
      ? `Refreshing Source Control; ${workflowChangedDescription} shown`
      : 'Refreshing Source Control'
  } else if (workflowChangedDescription) {
    workflowCountTitle = workflowChangedDescription
  }
  const workflowCount =
    changedPathCount > 0 || workflowRefreshVisible ? (
      <span className="inline-flex items-center gap-1" aria-label={workflowCountLabel}>
        {changedPathCount > 0 && <span>{changedPathCount}</span>}
        <IconRefresh
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 motion-reduce:animate-none',
            workflowRefreshVisible ? 'animate-spin opacity-60' : 'invisible',
          )}
        />
      </span>
    ) : null
  const stagedSource = useMemo(() => createTreeSource(staged), [staged])
  const unstagedSource = useMemo(() => createTreeSource(unstaged), [unstaged])
  const submitCommit = useCallback(async () => {
    const nextMessage = commitMessage.trim()
    if (nextMessage.length === 0 || repository.busy) return
    const reason = repository.getActionDisabledReason()
    if (reason != null) {
      setLocalError(reason)
      return
    }
    setLocalError(null)
    try {
      await repository.commit(nextMessage, amend)
      setCommitMessage('')
    } catch (error) {
      setLocalError(message(error))
    }
  }, [amend, commitMessage, repository, setCommitMessage, setLocalError])

  const backendDisabledReason = repository.getActionDisabledReason()
  return (
    <>
      <section
        ref={workflowPane}
        data-pane="source-control"
        className="section min-h-0 overflow-hidden md:flex md:flex-col"
      >
        <Header
          level="pane"
          className="border-t-0"
          actions={
            <SourceControlHeaderActions
              onConfirm={setPendingConfirm}
              onError={setLocalError}
              onOpenDialog={setOperationDialog}
              moreTrigger={moreTrigger}
            />
          }
          dataSection="workflow"
          icon={IconSymbolDiffstatFill}
          count={workflowCount}
          countTitle={workflowCountTitle}
          open={workflowOpen}
          title={headTitle}
          onOpenChange={setWorkflowOpen}
        />
        {workflowOpen && (
          <Pane
            ref={workflowContent}
            data-pane-body="source-control"
            className="min-h-0 md:flex md:flex-1 md:flex-col md:overflow-x-hidden max-md:overflow-visible"
          >
            <form
              className="commit-composer shrink-0 px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCommit()
              }}
            >
              <textarea
                ref={composer}
                aria-label="Commit message"
                className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[var(--ring)]"
                disabled={repository.busy}
                placeholder="Commit message"
                spellCheck
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.ctrlKey) {
                    event.preventDefault()
                    void submitCommit()
                  }
                }}
              />
              <div className="mbs-2 flex flex-wrap items-center gap-2">
                <label
                  htmlFor="gitna-amend"
                  className="me-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Switch
                    id="gitna-amend"
                    aria-label="Amend"
                    checked={amend}
                    disabled={repository.busy || snapshot.headOid == null}
                    onCheckedChange={setAmend}
                  />
                  Amend
                </label>
                <Button
                  type="submit"
                  variant="default"
                  size="sm"
                  disabled={
                    repository.busy ||
                    backendDisabledReason != null ||
                    commitMessage.trim().length === 0 ||
                    (staged.length === 0 && (!amend || snapshot.headOid == null))
                  }
                >
                  Commit
                </Button>
              </div>
            </form>

            <Conflicts onError={setLocalError} />

            {staged.length > 0 && (
              <ChangeSection
                changes={staged}
                modelId="gitna-staged-tree"
                onConfirm={setPendingConfirm}
                onRun={run}
                open={stagedOpen}
                scope="staged"
                source={stagedSource}
                title="Staged Changes"
                onOpenChange={setStagedOpen}
              />
            )}
            {unstaged.length > 0 && (
              <ChangeSection
                changes={unstaged}
                headerRef={changesHeader}
                modelId="gitna-unstaged-tree"
                onConfirm={setPendingConfirm}
                onRun={run}
                open={changesOpen}
                scope="unstaged"
                source={unstagedSource}
                title="Changes"
                onOpenChange={setChangesOpen}
              />
            )}
          </Pane>
        )}
      </section>
      {operationDialog != null && (
        <OperationModal
          kind={operationDialog}
          onClose={() => setOperationDialog(null)}
          onConfirm={setPendingConfirm}
          onError={setLocalError}
        />
      )}
    </>
  )
}
