import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/modal'
import { message, type PendingConfirm } from '../../components/tree-section'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { useLoadingIndicator } from '../../components/ui/loading'
import { Switch } from '../../components/ui/switch'
import { useRepository } from '../../repository/repository'

export type OperationDialog = 'compare' | 'integrate' | 'stash' | 'tags' | null

interface OperationModalProps {
  kind: Exclude<OperationDialog, null>
  onClose: () => void
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
}

export function OperationModal({ kind, onClose, onConfirm, onError }: OperationModalProps) {
  const repository = useRepository()
  const [from, setFrom] = useState('HEAD')
  const [to, setTo] = useState('HEAD')
  const [target, setTarget] = useState('')
  const [stashMessage, setStashMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [tagName, setTagName] = useState('')
  const [tagMessage, setTagMessage] = useState('')
  const [tagTarget, setTagTarget] = useState('HEAD')
  const [remote, setRemote] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const disabledReason = repository.getActionDisabledReason()

  useEffect(() => {
    if (repository.remotes.includes(remote)) return
    setRemote(repository.remotes[0] ?? '')
  }, [remote, repository.remotes])

  useEffect(() => {
    if (kind === 'stash') void repository.refreshStashes()
    if (kind === 'tags' || kind === 'compare') void repository.refreshTags()
    if (kind === 'integrate' || kind === 'tags' || kind === 'compare')
      void repository.refreshBranches()
  }, [kind, repository])

  const run = async (action: () => Promise<void>) => {
    if (disabledReason != null) {
      onError(disabledReason)
      return
    }
    setDialogError(null)
    onError(null)
    try {
      await action()
    } catch (error) {
      if (mounted.current) setDialogError(message(error))
    }
  }
  const referenceStatus = (
    <ReadStatus
      loading={repository.branchesLoading || repository.tagsLoading}
      error={repository.branchesError ?? repository.tagsError}
      onRetry={() => {
        void repository.refreshBranches()
        void repository.refreshTags()
      }}
    />
  )
  const refs = [
    'HEAD',
    ...repository.branches.map((branch) => branch.name),
    ...repository.tags.map((tag) => tag.name),
  ]

  if (kind === 'compare') {
    return (
      <Modal title="Compare references" onClose={onClose}>
        {referenceStatus}
        <div className="grid gap-3">
          <SelectField label="From" value={from} values={refs} onChange={setFrom} />
          <SelectField label="To" value={to} values={refs} onChange={setTo} />
          <Button
            variant="outline"
            size="sm"
            disabled={from === to || repository.compareLoading}
            onClick={() => void repository.openCompare(from, to, `${from}..${to}`)}
          >
            Compare
          </Button>
          <ReadStatus
            operation={`${from}\u0000${to}`}
            loading={repository.compareLoading}
            error={repository.compareError}
            onRetry={() => void repository.openCompare(from, to, `${from}..${to}`)}
          />
          {repository.compare != null &&
            !repository.compareLoading &&
            repository.compareError == null && (
              <p className="text-xs text-muted-foreground">
                {repository.compare.label} · {repository.compareFiles.length} changed files loaded
                in the review surface.
              </p>
            )}
        </div>
      </Modal>
    )
  }
  if (kind === 'integrate') {
    const branches = repository.branches
      .filter((branch) => !branch.current)
      .map((branch) => branch.name)
    return (
      <Modal
        title="Merge or rebase"
        error={dialogError}
        disabledReason={disabledReason}
        onClose={onClose}
      >
        <ReadStatus
          loading={repository.branchesLoading}
          error={repository.branchesError}
          onRetry={() => void repository.refreshBranches()}
        />
        <div className="grid gap-3">
          <SelectField
            label="Branch or reference"
            value={target}
            values={branches}
            onChange={setTarget}
            placeholder="Select a branch"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Merge preserves both histories. Rebase reapplies the current branch on top of the
            selected reference.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!target || disabledReason != null}
              onClick={() =>
                void run(async () => {
                  await repository.operation({ op: 'merge', name: target })
                  onClose()
                })
              }
            >
              Merge
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!target || disabledReason != null}
              onClick={() =>
                void run(async () => {
                  await repository.operation({ op: 'rebase', name: target })
                  onClose()
                })
              }
            >
              Rebase
            </Button>
          </div>
        </div>
      </Modal>
    )
  }
  if (kind === 'stash') {
    return (
      <Modal title="Stashes" error={dialogError} disabledReason={disabledReason} onClose={onClose}>
        <ReadStatus
          loading={repository.stashesLoading}
          error={repository.stashesError}
          onRetry={() => void repository.refreshStashes()}
        />
        <form
          className="mb-4 grid gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            const value = stashMessage.trim()
            if (!value) return
            void run(async () => {
              await repository.operation({ op: 'stash-push', message: value, includeUntracked })
              setStashMessage('')
            })
          }}
        >
          <Input
            aria-label="Stash message"
            placeholder="Stash message"
            value={stashMessage}
            onChange={(event) => setStashMessage(event.currentTarget.value)}
          />
          <label
            htmlFor="gitna-stash-include-untracked"
            className="flex cursor-pointer items-center gap-2 text-xs"
          >
            <Switch
              id="gitna-stash-include-untracked"
              aria-label="Include untracked"
              checked={includeUntracked}
              onCheckedChange={setIncludeUntracked}
            />
            Include untracked
          </label>
          <Button
            variant="outline"
            size="sm"
            type="submit"
            disabled={disabledReason != null}
            title={disabledReason ?? 'Create stash'}
          >
            Stash
          </Button>
        </form>
        <div className="grid gap-1">
          {repository.stashes.map((stash) => (
            <div
              key={stash.ref}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">
                <b>{stash.ref}</b> {stash.branch}: {stash.message}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabledReason != null}
                title={disabledReason ?? 'Apply stash'}
                onClick={() =>
                  void run(() => repository.operation({ op: 'stash-apply', ref: stash.ref }))
                }
              >
                Apply
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabledReason != null}
                title={disabledReason ?? 'Pop stash'}
                onClick={() =>
                  void run(() => repository.operation({ op: 'stash-pop', ref: stash.ref }))
                }
              >
                Pop
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabledReason != null}
                title={disabledReason ?? 'Drop stash'}
                onClick={() =>
                  onConfirm({
                    title: `Drop ${stash.ref}?`,
                    message: 'This permanently removes the stash. Gitna cannot undo this action.',
                    confirmLabel: 'Drop stash',
                    run: () => repository.operation({ op: 'stash-drop', ref: stash.ref }),
                  })
                }
              >
                Drop
              </Button>
            </div>
          ))}
          {repository.stashes.length === 0 &&
            !repository.stashesLoading &&
            repository.stashesError == null && (
              <p className="text-xs text-muted-foreground">No stashes</p>
            )}
        </div>
      </Modal>
    )
  }
  return (
    <Modal title="Tags" error={dialogError} disabledReason={disabledReason} onClose={onClose}>
      {referenceStatus}
      <form
        className="mb-4 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const name = tagName.trim()
          if (!name) return
          void run(async () => {
            await repository.operation({
              op: 'create-tag',
              name,
              start: tagTarget === 'HEAD' ? undefined : tagTarget,
              message: tagMessage.trim(),
            })
            setTagName('')
          })
        }}
      >
        <Input
          aria-label="New tag name"
          placeholder="Tag name"
          value={tagName}
          onChange={(event) => setTagName(event.currentTarget.value)}
        />
        <SelectField label="Target" value={tagTarget} values={refs} onChange={setTagTarget} />
        <Input
          aria-label="Annotated tag message"
          placeholder="Message (optional)"
          value={tagMessage}
          onChange={(event) => setTagMessage(event.currentTarget.value)}
        />
        <Button
          variant="outline"
          size="sm"
          type="submit"
          disabled={disabledReason != null}
          title={disabledReason ?? 'Create tag'}
        >
          Create
        </Button>
      </form>
      <label htmlFor="gitna-tag-remote" className="mb-3 grid gap-1 text-xs">
        Push to
        <select
          id="gitna-tag-remote"
          aria-label="Push to"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          disabled={repository.remotes.length === 0}
          value={remote}
          onChange={(event) => setRemote(event.currentTarget.value)}
        >
          {repository.remotes.length === 0 && <option value="">No remotes configured</option>}
          {repository.remotes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <div className="grid gap-1">
        {repository.tags.map((tag) => (
          <div
            key={tag.name}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">
              <b>{tag.name}</b>
              {tag.annotated ? ' (annotated)' : ''}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={remote === '' || disabledReason != null}
              title={disabledReason ?? (remote === '' ? 'Select a remote' : 'Push tag')}
              onClick={() =>
                void run(() => repository.operation({ op: 'push-tag', remote, name: tag.name }))
              }
            >
              Push
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabledReason != null}
              title={disabledReason ?? 'Delete tag'}
              onClick={() =>
                onConfirm({
                  title: `Delete tag ${tag.name}?`,
                  message: 'This removes the local tag reference. Gitna cannot undo the deletion.',
                  confirmLabel: 'Delete tag',
                  run: () => repository.operation({ op: 'delete-tag', name: tag.name }),
                })
              }
            >
              Delete
            </Button>
          </div>
        ))}
        {repository.tags.length === 0 &&
          !repository.tagsLoading &&
          repository.tagsError == null && <p className="text-xs text-muted-foreground">No tags</p>}
      </div>
    </Modal>
  )
}

function ReadStatus({
  loading,
  error,
  onRetry,
  operation,
}: {
  loading: boolean
  error: string | null
  onRetry: () => void
  operation?: unknown
}) {
  const loadingVisible = useLoadingIndicator(loading && error == null, operation)
  if (error == null)
    return (
      <p className="mb-3 min-h-4 text-xs text-muted-foreground" role="status">
        {loadingVisible && 'Loading… Previous results may remain visible.'}
      </p>
    )
  return (
    <div className="mb-3 text-xs" role="alert">
      <p>{error} Previous results may remain visible.</p>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function SelectField({
  label,
  onChange,
  placeholder,
  value,
  values,
}: {
  label: string
  onChange: (value: string) => void
  placeholder?: string
  value: string
  values: string[]
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span>{label}</span>
      <select
        aria-label={label === 'Branch or reference' ? label : `Compare ${label.toLowerCase()}`}
        className="h-9 cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-[var(--ring)]"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {placeholder != null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}
