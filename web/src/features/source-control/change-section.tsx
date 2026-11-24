import { IconMinus, IconPlus, IconReply, IconSymbolDiffstatFill } from '@pierre/icons'
import type { ContextMenuItem, ContextMenuOpenContext, FileTreeOptions } from '@pierre/trees'
import { useCallback, useMemo } from 'react'
import {
  FileTreeContextMenuTrigger,
  TreeSection,
  trimDirectoryPath,
  type PendingConfirm,
} from '../../components/tree-section'
import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../../components/ui/dropdown-menu'
import type { FileTreeSource } from '../../lib/review-types'
import type { TreeFile } from '../../lib/tree-files'
import type { ChangeScope } from '../../lib/types'
import { useRepository } from '../../repository/repository-provider'

export const CHANGE_TREE_VIRTUALIZATION_THRESHOLD = 8

interface DiscardConfirmationCopy {
  confirmLabel: string
  message: string
  title: string
}

function discardConfirmationCopy(
  name: string | null,
  changes: readonly TreeFile[],
  group: boolean,
): DiscardConfirmationCopy {
  const untracked = changes.filter((change) => change.kind === 'untracked').length
  const tracked = changes.length - untracked

  if (!group && name != null && changes.length === 1) {
    return untracked === 1
      ? {
          title: `Delete untracked file ${name}?`,
          message: 'This permanently deletes the file. This cannot be undone.',
          confirmLabel: 'Delete file',
        }
      : {
          title: `Discard changes to ${name}?`,
          message: 'The file will be restored to its staged version. This cannot be undone.',
          confirmLabel: 'Discard changes',
        }
  }

  const scope = name == null ? 'all changes' : `changes in ${name}`
  const effects = [
    tracked > 0 ? `restore ${tracked} tracked ${tracked === 1 ? 'file' : 'files'}` : null,
    untracked > 0
      ? `permanently delete ${untracked} untracked ${untracked === 1 ? 'file' : 'files'}`
      : null,
  ].filter((effect): effect is string => effect != null)

  return {
    title: `Discard ${scope}?`,
    message: `This will ${effects.join(' and ')}. This cannot be undone.`,
    confirmLabel: untracked === changes.length ? 'Delete files' : 'Discard changes',
  }
}

function mutationPaths(changes: readonly TreeFile[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath == null ? [change.path] : [change.oldPath, change.path],
      ),
    ),
  ]
}

function ChangeContextMenu({
  canOpen,
  canReveal,
  context,
  path,
  directory,
  onOpen,
  onReveal,
}: {
  canOpen: boolean
  canReveal: boolean
  context: ContextMenuOpenContext
  path: string
  directory: boolean
  onOpen: (path: string) => void
  onReveal: (path: string) => void
}) {
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) context.close()
      }}
    >
      <FileTreeContextMenuTrigger context={context} />
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={context.anchorRect.width === 0 && context.anchorRect.height === 0 ? 0 : -2}
        className="min-w-44"
        data-file-tree-context-menu-root="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          context.restoreFocus()
        }}
      >
        {!directory && (
          <DropdownMenuItem
            disabled={!canOpen}
            onSelect={() => {
              context.close()
              onOpen(path)
            }}
          >
            Open in Explorer
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!canReveal}
          onSelect={() => {
            context.close()
            onReveal(path)
          }}
        >
          Reveal in File Manager
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ChangeSectionProps {
  changes: readonly TreeFile[]
  headerRef?: React.Ref<HTMLButtonElement>
  modelId: string
  onConfirm: (confirm: PendingConfirm) => void
  onOpenChange: (open: boolean) => void
  onRun: (action: () => Promise<void>) => Promise<void>
  open: boolean
  scope: ChangeScope
  source: FileTreeSource
  title: string
}

export function ChangeSection({
  changes,
  headerRef,
  modelId,
  onConfirm,
  onOpenChange,
  onRun,
  open,
  scope,
  source,
  title,
}: ChangeSectionProps) {
  const repository = useRepository()
  const changesByPath = useMemo(
    () => new Map(changes.map((change) => [change.path, change])),
    [changes],
  )
  const disabledReason = repository.getActionDisabledReason()
  const selectedPath =
    repository.selection?.scope === scope ? repository.selection.change.path : null
  const discardChanges = useCallback(
    async (targetChanges: readonly TreeFile[]) => {
      const tracked = targetChanges.filter((change) => change.kind !== 'untracked')
      const untracked = targetChanges.filter((change) => change.kind === 'untracked')
      if (tracked.length > 0) {
        await repository.mutate({ op: 'discard', paths: mutationPaths(tracked) })
      }
      if (untracked.length > 0) {
        await repository.mutate({ op: 'delete', paths: mutationPaths(untracked) })
      }
    },
    [repository],
  )
  const renderContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const path = trimDirectoryPath(item.path)
      return (
        <ChangeContextMenu
          canOpen={repository.canOpenRepositoryFile(path)}
          canReveal={
            repository.getActionDisabledReason() == null && repository.canRevealPath(item.path)
          }
          context={context}
          path={path}
          directory={item.kind !== 'file'}
          onOpen={(nextPath) => void onRun(() => repository.openRepositoryFile(nextPath, true))}
          onReveal={(nextPath) => void onRun(() => repository.revealPath(nextPath))}
        />
      )
    },
    [onRun, repository],
  )
  const renderRowActions = useCallback<NonNullable<FileTreeOptions['renderRowActions']>>(
    ({ item, row }) => {
      const itemPath = item.path.replace(/[\\/]+$/, '')
      const itemChanges =
        row.kind === 'file'
          ? [changesByPath.get(itemPath)].filter((change): change is TreeFile => change != null)
          : changes.filter((change) => change.path.startsWith(`${itemPath}/`))
      if (itemChanges.length === 0) return null
      const disabledSuffix = disabledReason == null ? '' : ` — ${disabledReason}`
      if (scope === 'staged') {
        return [
          {
            id: 'unstage',
            label: `Unstage ${item.name}${disabledSuffix}`,
            icon: { name: 'gitna-action-unstage' },
            disabled: repository.busy || disabledReason != null,
            onAction: () =>
              void onRun(() =>
                repository.mutate({ op: 'unstage', paths: mutationPaths(itemChanges) }),
              ),
          },
        ]
      }
      return [
        {
          id: 'discard',
          label: `Discard changes in ${item.name}${disabledSuffix}`,
          icon: { name: 'gitna-action-discard' },
          disabled: repository.busy || disabledReason != null,
          onAction: () =>
            onConfirm({
              ...discardConfirmationCopy(item.name, itemChanges, row.kind === 'directory'),
              run: () => discardChanges(itemChanges),
            }),
        },
        {
          id: 'stage',
          label: `Stage ${item.name}${disabledSuffix}`,
          icon: { name: 'gitna-action-stage' },
          disabled: repository.busy || disabledReason != null,
          onAction: () =>
            void onRun(() => repository.mutate({ op: 'stage', paths: mutationPaths(itemChanges) })),
        },
      ]
    },
    [
      changes,
      changesByPath,
      discardChanges,
      disabledReason,
      onConfirm,
      onRun,
      repository,
      repository.busy,
      scope,
    ],
  )

  const headerActions =
    scope === 'staged' ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-only"
        aria-label="Unstage all changes"
        disabled={repository.busy || disabledReason != null}
        title={disabledReason ?? 'Unstage All Changes'}
        onClick={() =>
          void onRun(() => repository.mutate({ op: 'unstage', paths: mutationPaths(changes) }))
        }
      >
        <IconMinus className="size-3" />
      </Button>
    ) : (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon-only"
          aria-label="Discard all changes"
          disabled={repository.busy || disabledReason != null}
          title={disabledReason ?? 'Discard All Changes'}
          onClick={() =>
            onConfirm({
              ...discardConfirmationCopy(null, changes, true),
              run: () => discardChanges(changes),
            })
          }
        >
          <IconReply className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-only"
          aria-label="Stage all changes"
          disabled={repository.busy || disabledReason != null}
          title={disabledReason ?? 'Stage All Changes'}
          onClick={() =>
            void onRun(() => repository.mutate({ op: 'stage', paths: mutationPaths(changes) }))
          }
        >
          <IconPlus className="size-3" />
        </Button>
      </>
    )

  return (
    <TreeSection
      fill={source.pathCount > CHANGE_TREE_VIRTUALIZATION_THRESHOLD}
      dataSection={scope === 'staged' ? 'staged' : 'changes'}
      emptyMessage={changes.length === 0 ? 'No changes' : 'No matching files'}
      headerActions={headerActions}
      headerRef={headerRef}
      icon={IconSymbolDiffstatFill}
      modelId={modelId}
      open={open}
      renderContextMenu={renderContextMenu}
      renderRowActions={renderRowActions}
      selectedPath={selectedPath}
      source={source}
      title={title}
      onOpenChange={onOpenChange}
      onSelectPath={(path) => repository.select(scope, path)}
    />
  )
}
