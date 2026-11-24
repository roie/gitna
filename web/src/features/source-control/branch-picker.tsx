import { IconBranch } from '@pierre/icons'
import { useCallback, useRef, useState } from 'react'
import { message, type PendingConfirm } from '../../components/tree-section'
import { Button } from '../../components/ui/button'
import { CHROME_ICON_BUTTON_CLASS } from '../../components/ui/button-styles'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { Input } from '../../components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip'
import { ApiError } from '../../lib/api'
import { useRepository } from '../../repository/repository'

export function BranchPicker({
  onConfirm,
  onError,
  run,
}: {
  onConfirm: (confirm: PendingConfirm) => void
  onError: (error: string | null) => void
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const repository = useRepository()
  const disabledReason = repository.getActionDisabledReason()
  const [branchQuery, setBranchQuery] = useState('')
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const branchMenuContent = useRef<HTMLDivElement>(null)
  const branchMenuTriggers = useRef(new Map<string, HTMLDivElement>())
  const [branchSubmenuOffset, setBranchSubmenuOffset] = useState(0)
  const normalizedBranchQuery = branchQuery.trim().toLocaleLowerCase()
  const localBranches = repository.branches.filter(
    (branch) => !branch.remote && branch.name.toLocaleLowerCase().includes(normalizedBranchQuery),
  )
  const remoteBranches = repository.branches.filter(
    (branch) => branch.remote && branch.name.toLocaleLowerCase().includes(normalizedBranchQuery),
  )

  const deleteBranch = useCallback(
    async (branch: string) => {
      onError(null)
      try {
        await repository.deleteBranch(branch)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'branch-not-merged') {
          onConfirm({
            title: `Delete branch ${branch}?`,
            message:
              'The branch is not fully merged. Deleting it discards commits only reachable from it.',
            confirmLabel: 'Delete anyway',
            run: () => repository.deleteBranch(branch, true),
          })
          return
        }
        onError(message(error))
      }
    },
    [onConfirm, onError, repository],
  )

  return (
    <DropdownMenu
      open={branchMenuOpen}
      onOpenChange={(open) => {
        setBranchMenuOpen(open)
        if (open) void repository.refreshBranches()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-only"
          aria-label={`Switch branch · ${repository.snapshot?.headBranch ?? 'detached'}`}
          title={`Switch branch · ${repository.snapshot?.headBranch ?? 'detached'}`}
          className={CHROME_ICON_BUTTON_CLASS}
        >
          <IconBranch className="size-4 md:size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={branchMenuContent} align="start" className="w-72 p-2">
        <form
          className="mb-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const name = branchQuery.trim()
            if (name.length === 0 || disabledReason != null) return
            setBranchQuery('')
            setBranchMenuOpen(false)
            void run(() => repository.createBranch(name))
          }}
        >
          <Input
            inputSize="sm"
            aria-label="Search or create branch"
            placeholder="Search or create branch"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.currentTarget.value)}
          />
          <Button
            variant="outline"
            size="sm"
            type="submit"
            disabled={branchQuery.trim() === '' || disabledReason != null}
            title={disabledReason ?? undefined}
          >
            New
          </Button>
        </form>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Local branches
        </p>
        <TooltipProvider delayDuration={400} skipDelayDuration={150}>
          {localBranches.map((branch) =>
            branch.current ? (
              <DropdownMenuItem key={branch.name} disabled>
                <span className="w-4" />
                <span className="min-w-0 flex-1 wrap-anywhere font-medium">{branch.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  Current
                  {branch.upstream != null && (
                    <>
                      {' · '}
                      {branch.upstream}
                      {branch.ahead > 0 ? ` ↑${branch.ahead}` : ''}
                      {branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                    </>
                  )}
                </span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSub
                key={branch.name}
                onOpenChange={(open) => {
                  if (!open || branchMenuContent.current == null) return
                  const bounds = branchMenuContent.current.getBoundingClientRect()
                  const viewportWidth = document.documentElement.clientWidth
                  const availableWidth = Math.max(bounds.left, viewportWidth - bounds.right)
                  const triggerWidth = branchMenuTriggers.current.get(branch.name)?.offsetWidth ?? 0
                  setBranchSubmenuOffset(
                    availableWidth < bounds.width ? -(triggerWidth + bounds.width) / 2 : 0,
                  )
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuSubTrigger
                      ref={(element) => {
                        if (element == null) branchMenuTriggers.current.delete(branch.name)
                        else branchMenuTriggers.current.set(branch.name, element)
                      }}
                      onPointerLeave={(event) => {
                        // Overlapping content invalidates Radix's sideways pointer-grace area.
                        if (branchSubmenuOffset < 0) event.preventDefault()
                      }}
                      disabled={repository.busy || disabledReason != null}
                    >
                      <span className="w-4" />
                      <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                      {branch.upstream != null && (
                        <span className="text-[11px] text-muted-foreground">
                          {branch.ahead > 0 ? `↑${branch.ahead}` : ''}
                          {branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                        </span>
                      )}
                    </DropdownMenuSubTrigger>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] wrap-anywhere">
                    {branch.name}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuSubContent
                  sideOffset={branchSubmenuOffset}
                  collisionPadding={8}
                  className="w-72 max-w-[min(18rem,var(--radix-dropdown-menu-content-available-width))]"
                >
                  <p className="px-2 py-1.5 text-xs wrap-anywhere text-muted-foreground">
                    {branch.name}
                  </p>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={disabledReason != null}
                    onSelect={() => void run(() => repository.switchBranch(branch.name))}
                  >
                    Switch to branch
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => void deleteBranch(branch.name)}
                  >
                    Delete branch…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ),
          )}
          {remoteBranches.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Remote branches
              </p>
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                Select a remote branch to check it out locally.
              </p>
              {remoteBranches.map((branch) => {
                const localName = branch.name.slice(branch.name.indexOf('/') + 1)
                return (
                  <Tooltip key={branch.name}>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        aria-label={`Checkout ${branch.name} as ${localName}`}
                        disabled={repository.busy || disabledReason != null}
                        onSelect={() =>
                          void run(() => repository.createBranch(localName, branch.name))
                        }
                      >
                        <span className="w-4" />
                        <span className="min-w-0 flex-1 wrap-anywhere">{branch.name}</span>
                        <span className="min-w-0 flex-1 wrap-anywhere text-[11px] text-muted-foreground">
                          Checkout as {localName}
                        </span>
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] wrap-anywhere">
                      {branch.name}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </>
          )}
          {localBranches.length === 0 && remoteBranches.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No matching branches</p>
          )}
        </TooltipProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
