import { IconDiffSplit, IconX } from '@pierre/icons'
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import {
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Row } from '../components/ui/row'
import { cn } from '../lib/cn'
import { useRepository } from '../repository/repository-provider'

const repositoryTabIconResolver = createFileTreeIconResolver('complete')
const repositoryTabIconSprite = getBuiltInSpriteSheet('complete')

function RepositoryTabIconSprite() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host == null) return
    const parsed = new DOMParser().parseFromString(repositoryTabIconSprite, 'text/html')
    const sprites = [...parsed.body.children].filter(
      (element): element is SVGSVGElement => element.localName === 'svg',
    )
    if (sprites.length === 0) return
    for (const sprite of sprites) {
      for (const element of sprite.querySelectorAll('script, foreignObject')) element.remove()
      for (const element of sprite.querySelectorAll('*')) {
        for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
          const attribute = element.attributes.item(index)
          if (attribute?.name.toLowerCase().startsWith('on')) {
            element.removeAttribute(attribute.name)
          }
        }
      }
    }
    host.replaceChildren(...sprites.map((sprite) => document.importNode(sprite, true)))
    return () => host.replaceChildren()
  }, [])
  return <div ref={hostRef} aria-hidden="true" className="absolute size-0 overflow-hidden" />
}

export function TabBar({
  dirtyPaths,
  onClose,
  onError,
}: {
  dirtyPaths: ReadonlySet<string>
  onClose: (paths: readonly string[], closeComparison?: boolean) => void
  onError: (error: string) => void
}) {
  const repository = useRepository()
  const tablistRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{
    anchorRect: DOMRect
    focusTarget: HTMLButtonElement
    index: number
    path: string
  } | null>(null)
  const openPaths = repository.repositoryOpenPaths
  const comparison = repository.repositoryFileComparison
  const reviewTabs = [
    ...(repository.compare == null
      ? []
      : [
          {
            kind: 'compare' as const,
            label: `${repository.compare.from} ↔ ${repository.compare.to}`,
          },
        ]),
    ...(repository.commitDiff == null
      ? []
      : [
          {
            kind: 'commit' as const,
            label: `${repository.commitDiff.oid.slice(0, 7)} · ${repository.commitDiff.subject}`,
          },
        ]),
  ]
  const hasReviewTabs = comparison != null || reviewTabs.length > 0
  useEffect(() => {
    const selector =
      repository.activeReview != null
        ? `[data-review-tab="${repository.activeReview}"]`
        : repository.repositoryFileComparisonActive
          ? '[data-comparison-tab="true"]'
          : `[data-tab-index="${openPaths.indexOf(repository.repositoryFilePath ?? '')}"]`
    queueMicrotask(() =>
      tablistRef.current
        ?.querySelector<HTMLElement>(selector)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    )
  }, [
    openPaths,
    repository.activeReview,
    repository.repositoryFileComparisonActive,
    repository.repositoryFilePath,
  ])
  if (openPaths.length === 0 && !hasReviewTabs) return null
  const openContextMenu = (
    path: string,
    index: number,
    focusTarget: HTMLButtonElement,
    anchorRect: DOMRect,
  ) => setContextMenu({ anchorRect, focusTarget, index, path })
  const closeFromMenu = (paths: readonly string[], closeComparison = false) => {
    setContextMenu(null)
    onClose(paths, closeComparison)
  }
  const closeReviewTab = (kind: 'compare' | 'commit') => {
    if (kind === 'compare') repository.clearCompare()
    else repository.closeCommitReview()
    queueMicrotask(() =>
      tablistRef.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus(),
    )
  }
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-muted/20">
      <RepositoryTabIconSprite />
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Open repository files"
        className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain px-2"
        onWheel={(event) => {
          const delta =
            Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
          if (delta === 0) return
          const previousScrollLeft = event.currentTarget.scrollLeft
          event.currentTarget.scrollLeft += delta
          if (event.currentTarget.scrollLeft !== previousScrollLeft) event.preventDefault()
        }}
      >
        {reviewTabs.map(({ kind, label }) => (
          <Tab
            key={kind}
            data-review-tab={kind}
            className="max-w-72"
            active={repository.activeReview === kind}
            closeLabel={
              kind === 'compare' ? `Close ref comparison ${label}` : `Close commit review ${label}`
            }
            closeTitle={kind === 'compare' ? 'Close ref comparison' : 'Close commit review'}
            icon={<IconDiffSplit className="size-4 shrink-0" />}
            label={label}
            title={label}
            onClose={() => closeReviewTab(kind)}
            onSelect={() => repository.activateReviewTab(kind)}
          />
        ))}
        {comparison != null && (
          <Tab
            data-comparison-tab="true"
            className="max-w-72"
            active={repository.repositoryFileComparisonActive}
            closeLabel={`Close comparison of ${comparison.leftPath} and ${comparison.rightPath}`}
            closeTitle="Close comparison"
            icon={<IconDiffSplit className="size-4 shrink-0" />}
            label={
              <>
                {comparison.leftPath.split('/').at(-1) ?? comparison.leftPath} ↔{' '}
                {comparison.rightPath.split('/').at(-1) ?? comparison.rightPath}
              </>
            }
            title={`${comparison.leftPath} ↔ ${comparison.rightPath}`}
            onClose={() => repository.closeRepositoryFileComparison()}
            onSelect={() => repository.activateRepositoryFileComparison()}
          />
        )}
        {openPaths.map((path, index) => {
          const active =
            repository.activeReview == null &&
            !repository.repositoryFileComparisonActive &&
            repository.repositoryFilePath === path
          const name = repository.isUntitledPath(path)
            ? (repository.untitledDocument(path)?.label ?? 'Untitled')
            : (path.split('/').at(-1) ?? path)
          const icon = repositoryTabIconResolver.resolveIcon('file-tree-icon-file', path)
          const iconHref = `#${icon.name.replace(/^#/, '')}`
          const iconViewBox =
            icon.viewBox ?? `0 0 ${String(icon.width ?? 16)} ${String(icon.height ?? 16)}`
          return (
            <Tab
              key={path}
              data-tab-index={index}
              className="max-w-64"
              active={active}
              closeLabel={`Close ${path}`}
              closeTitle={`Close ${path}`}
              icon={
                <svg
                  aria-hidden="true"
                  data-icon-name={icon.name}
                  data-icon-token={icon.token}
                  viewBox={iconViewBox}
                  width={icon.width ?? 16}
                  height={icon.height ?? 16}
                  className="size-4 shrink-0"
                  style={
                    icon.token == null
                      ? undefined
                      : {
                          color: `var(--trees-file-icon-color-${icon.token}, var(--trees-file-icon-color))`,
                        }
                  }
                >
                  <use href={iconHref} />
                </svg>
              }
              label={name}
              dirty={dirtyPaths.has(path)}
              title={path}
              onClose={() => onClose([path])}
              onContextMenu={(event) => {
                event.preventDefault()
                const tab = event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')
                if (tab != null) openContextMenu(path, index, tab, tab.getBoundingClientRect())
              }}
              onSelect={() => repository.selectRepositoryFile(path)}
              onTabKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                openContextMenu(
                  path,
                  index,
                  event.currentTarget,
                  event.currentTarget.getBoundingClientRect(),
                )
              }}
            />
          )
        })}
      </div>
      {contextMenu != null && (
        <DropdownMenu
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null)
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              aria-hidden="true"
              tabIndex={-1}
              type="button"
              className="fixed size-px opacity-0"
              style={{ left: contextMenu.anchorRect.left, top: contextMenu.anchorRect.bottom }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={0}
            className="min-w-44"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              const { focusTarget, path } = contextMenu
              queueMicrotask(() => {
                if (repository.repositoryOpenPaths.includes(path) && focusTarget.isConnected) {
                  focusTarget.focus()
                  return
                }
                tablistRef.current
                  ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
                  ?.focus()
              })
            }}
          >
            <DropdownMenuItem
              disabled={
                repository.getActionDisabledReason() != null ||
                !repository.canRevealPath(contextMenu.path)
              }
              onSelect={() => {
                const path = contextMenu.path
                setContextMenu(null)
                void repository
                  .revealPath(path)
                  .catch((error) => onError(error instanceof Error ? error.message : String(error)))
              }}
            >
              Reveal in File Manager
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => closeFromMenu([contextMenu.path])}>
              Close
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={openPaths.length === 1 && !hasReviewTabs}
              onSelect={() =>
                closeFromMenu(
                  openPaths.filter((path) => path !== contextMenu.path),
                  true,
                )
              }
            >
              Close Others
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={contextMenu.index === 0 && !hasReviewTabs}
              onSelect={() => closeFromMenu(openPaths.slice(0, contextMenu.index), true)}
            >
              Close Left
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={contextMenu.index === openPaths.length - 1}
              onSelect={() => closeFromMenu(openPaths.slice(contextMenu.index + 1))}
            >
              Close Right
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!hasReviewTabs && openPaths.every((path) => dirtyPaths.has(path))}
              onSelect={() =>
                closeFromMenu(
                  openPaths.filter((path) => !dirtyPaths.has(path)),
                  true,
                )
              }
            >
              Close Clean
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => closeFromMenu(openPaths, true)}>
              Close All
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

interface TabProps extends Omit<ComponentProps<'div'>, 'onSelect' | 'title'> {
  active: boolean
  closeLabel: string
  closeTitle: string
  icon: ReactNode
  dirty?: boolean
  label: ReactNode
  title: string
  onClose: () => void
  onSelect: () => void
  onTabKeyDown?: KeyboardEventHandler<HTMLButtonElement>
}

function Tab({
  active,
  className,
  closeLabel,
  closeTitle,
  dirty = false,
  icon,
  label,
  title,
  onClose,
  onSelect,
  onTabKeyDown,
  ...props
}: TabProps) {
  return (
    <div
      className={cn('shrink-0', className)}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      {...props}
    >
      <Row
        role="tab"
        aria-selected={active}
        selected={active}
        className={cn('relative pe-3', !active && 'text-muted-foreground hover:text-foreground')}
        icon={icon}
        label={label}
        status={
          dirty && (
            <span
              aria-label="Unsaved changes"
              className="size-1.5 shrink-0 rounded-full bg-current"
            />
          )
        }
        title={title}
        onClick={onSelect}
        onKeyDown={onTabKeyDown}
        actions={
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-e-md bg-linear-to-l from-accent from-60% to-transparent ps-4 pe-1 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:bg-none [@media(hover:none)]:p-0 [@media(hover:none)]:opacity-100">
            <button
              type="button"
              className="pointer-events-auto flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              aria-label={closeLabel}
              title={closeTitle}
              onClick={onClose}
            >
              <IconX className="size-3" />
            </button>
          </span>
        }
      />
    </div>
  )
}
