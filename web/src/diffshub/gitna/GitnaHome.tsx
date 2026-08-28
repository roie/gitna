import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import {
  IconArrowLeftBar,
  IconArrowUpRight,
  IconBrandGit,
  IconFolder,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '@pierre/icons'

import type { Folder, FolderCatalog } from '../../lib/types'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { ThemedSurface } from '../components/ThemedSurface'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/Tooltip'
import { GitnaLogo } from './GitnaLogo'

interface GitnaHomeProps {
  catalog: FolderCatalog | null
  error: string | null
  loading: boolean
  opening: boolean
  switchError: string | null
  onBack(): void
  onClearSwitchError(): void
  onOpenFolder(path: string): Promise<void>
  onOpenFolderInNewTab(path: string): Promise<void>
  onRefresh(): void
  onRemoveRecentFolder(path: string): Promise<void>
}

const openedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatOpenedAt(value: string): string | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : openedAt.format(date)
}

function OpenFolderForm({
  error,
  inputRef,
  opening,
  onClearError,
  onOpenFolder,
}: {
  error: string | null
  inputRef: RefObject<HTMLInputElement | null>
  opening: boolean
  onClearError(): void
  onOpenFolder(path: string): Promise<void>
}) {
  const [path, setPath] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const visibleError = error ?? localError

  useEffect(() => inputRef.current?.focus(), [])

  const open = async () => {
    const nextPath = path.trim()
    if (nextPath === '') return
    setLocalError(null)
    onClearError()
    try {
      await onOpenFolder(nextPath)
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <section aria-labelledby="open-folder-title" className="mt-10">
      <h2 id="open-folder-title" className="text-sm font-medium text-foreground">
        Open Folder
      </h2>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          void open()
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            ref={inputRef}
            aria-describedby={visibleError == null ? undefined : 'gitna-home-open-error'}
            aria-invalid={visibleError != null}
            aria-label="Folder path"
            autoComplete="off"
            disabled={opening}
            placeholder="/path/to/folder"
            spellCheck={false}
            value={path}
            onChange={(event) => {
              setPath(event.currentTarget.value)
              setLocalError(null)
              onClearError()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setPath('')
                setLocalError(null)
                onClearError()
              }
            }}
          />
          {visibleError != null && (
            <p id="gitna-home-open-error" className="mt-2 text-sm text-destructive" role="alert">
              {visibleError}
            </p>
          )}
        </div>
        <Button type="submit" disabled={opening || path.trim() === ''}>
          Open Folder
        </Button>
      </form>
    </section>
  )
}

function FolderRow({
  action,
  disabled = false,
  folder,
  onOpen,
  onOpenInNewTab,
  onRemove,
}: {
  action: 'new-tab' | 'remove' | null
  disabled?: boolean
  folder: Folder
  onOpen(): void
  onOpenInNewTab(): void
  onRemove(): void
}) {
  const opened = formatOpenedAt(folder.lastOpened)
  const rowDisabled = disabled || action != null
  return (
    <div className="group flex min-w-0 items-center gap-1 py-1">
      <button
        type="button"
        data-recent-folder
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-wait disabled:opacity-50"
        disabled={rowDisabled}
        onClick={onOpen}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          {folder.repository ? (
            <IconBrandGit className="size-4" />
          ) : (
            <IconFolder className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{folder.name}</span>
          <span className="mt-1 block truncate text-sm text-muted-foreground" title={folder.path}>
            {folder.path}
          </span>
        </span>
        <span className="hidden shrink-0 text-right md:block">
          <span className="block text-xs text-muted-foreground">
            {folder.repository ? 'Git repository' : 'Folder'}
          </span>
          {opened != null && (
            <time
              className="mt-1 block text-[11px] text-muted-foreground"
              dateTime={folder.lastOpened}
            >
              {opened}
            </time>
          )}
        </span>
      </button>
      <TooltipProvider delayDuration={500}>
        <span className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label={`Open ${folder.name} in new tab`}
                className="size-9 shadow-none sm:size-8"
                disabled={rowDisabled}
                onClick={onOpenInNewTab}
              >
                <IconArrowUpRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="shadow-none">Open in New Tab</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label={`Remove ${folder.name} from recent folders`}
                className="size-9 shadow-none hover:text-destructive sm:size-8"
                disabled={rowDisabled}
                onClick={onRemove}
              >
                <IconTrash className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="shadow-none">Remove from Recent</TooltipContent>
          </Tooltip>
        </span>
      </TooltipProvider>
    </div>
  )
}

export function GitnaHome({
  catalog,
  error,
  loading,
  opening,
  switchError,
  onBack,
  onClearSwitchError,
  onOpenFolder,
  onOpenFolderInNewTab,
  onRefresh,
  onRemoveRecentFolder,
}: GitnaHomeProps) {
  const [query, setQuery] = useState('')
  const [recentAction, setRecentAction] = useState<{
    path: string
    type: 'new-tab' | 'remove'
  } | null>(null)
  const [recentActionError, setRecentActionError] = useState<string | null>(null)
  const [removalFocusIndex, setRemovalFocusIndex] = useState<number | null>(null)
  const openFolderInputRef = useRef<HTMLInputElement>(null)
  const recentListRef = useRef<HTMLUListElement>(null)
  const recentSearchRef = useRef<HTMLInputElement>(null)
  const recent = useMemo(
    () => catalog?.recent.filter((folder) => folder.path !== catalog.current.path) ?? [],
    [catalog],
  )
  const filteredRecent = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (normalizedQuery === '') return recent
    return recent.filter((folder) =>
      `${folder.name}\n${folder.path}`.toLocaleLowerCase().includes(normalizedQuery),
    )
  }, [query, recent])
  const showRecentFolders = recent.length > 0 || error != null

  useEffect(() => {
    if (removalFocusIndex == null) return
    setRemovalFocusIndex(null)
    const buttons = recentListRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-recent-folder]',
    )
    const nextButton = buttons?.[Math.min(removalFocusIndex, buttons.length - 1)]
    if (nextButton != null) {
      nextButton.focus()
    } else if (recentSearchRef.current != null) {
      recentSearchRef.current.focus()
    } else {
      openFolderInputRef.current?.focus()
    }
  }, [filteredRecent, removalFocusIndex])

  const focusRecentFolder = (position: 'first' | 'last') => {
    const buttons = recentListRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-recent-folder]',
    )
    if (buttons == null || buttons.length === 0) return
    buttons[position === 'first' ? 0 : buttons.length - 1]?.focus()
  }

  return (
    <ThemedSurface
      as="main"
      aria-labelledby="gitna-home-title"
      className="relative col-span-full row-span-full min-h-0 overflow-y-auto [grid-column:1/-1] [grid-row:1/-1]"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute top-4 left-4 sm:top-6 sm:left-6"
        onClick={onBack}
      >
        <IconArrowLeftBar className="size-4" />
        <span className="hidden sm:inline">
          Back{catalog?.current.name == null ? '' : ` to ${catalog.current.name}`}
        </span>
        <span className="sm:hidden">Back</span>
      </Button>

      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-5 pt-28 pb-16 sm:px-8 sm:pt-36 sm:pb-24 lg:pt-40">
        <div className="flex min-w-0 items-center justify-center gap-4">
          <GitnaLogo className="size-12" />
          <div className="min-w-0">
            <h1
              id="gitna-home-title"
              className="text-balance text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl"
            >
              Welcome back to Gitna
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A local Git workbench that runs in your browser.
            </p>
          </div>
        </div>

        <OpenFolderForm
          error={switchError}
          inputRef={openFolderInputRef}
          opening={opening}
          onClearError={onClearSwitchError}
          onOpenFolder={onOpenFolder}
        />

        {showRecentFolders && (
          <section aria-labelledby="recent-folders-title" className="mt-10">
            <div className="flex items-center justify-between gap-4">
              <h2 id="recent-folders-title" className="text-sm font-medium text-foreground">
                Recent folders
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label="Refresh recent folders"
                title="Refresh recent folders"
                disabled={loading}
                onClick={onRefresh}
              >
                <IconRefresh className="size-4" />
              </Button>
            </div>

            {error != null && (
              <div
                className="mt-3 flex items-center justify-between gap-4 border-y border-border py-4"
                role="alert"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Couldn’t load recent folders
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
                  Try again
                </Button>
              </div>
            )}

            {recent.length > 0 && (
              <div className="relative mt-3">
                <IconSearch
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={recentSearchRef}
                  type="search"
                  aria-label="Search recent folders"
                  autoComplete="off"
                  className="pl-8"
                  disabled={opening}
                  placeholder="Search recent folders"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      focusRecentFolder(event.key === 'ArrowDown' ? 'first' : 'last')
                    } else if (event.key === 'Escape' && query !== '') {
                      event.preventDefault()
                      setQuery('')
                    }
                  }}
                />
              </div>
            )}

            {filteredRecent.length > 0 && (
              <ul
                ref={recentListRef}
                className="mt-3 divide-y divide-border border-y border-border"
                onKeyDown={(event) => {
                  if (
                    event.key !== 'ArrowDown' &&
                    event.key !== 'ArrowUp' &&
                    event.key !== 'Home' &&
                    event.key !== 'End' &&
                    event.key !== 'Escape'
                  ) {
                    return
                  }
                  const buttons = [
                    ...(recentListRef.current?.querySelectorAll<HTMLButtonElement>(
                      'button[data-recent-folder]',
                    ) ?? []),
                  ]
                  const current = buttons.indexOf(event.target as HTMLButtonElement)
                  if (current < 0) return
                  event.preventDefault()
                  if (event.key === 'Escape') {
                    recentSearchRef.current?.focus()
                    return
                  }
                  let next = current + (event.key === 'ArrowDown' ? 1 : -1)
                  if (event.key === 'Home') next = 0
                  else if (event.key === 'End') next = buttons.length - 1
                  else next = (next + buttons.length) % buttons.length
                  buttons[next]?.focus()
                }}
              >
                {filteredRecent.map((folder, index) => {
                  const action = recentAction?.path === folder.path ? recentAction.type : null
                  return (
                    <li key={folder.path}>
                      <FolderRow
                        action={action}
                        disabled={opening || recentAction != null}
                        folder={folder}
                        onOpen={() => {
                          setRecentActionError(null)
                          onClearSwitchError()
                          void onOpenFolder(folder.path)
                        }}
                        onOpenInNewTab={() => {
                          setRecentAction({ path: folder.path, type: 'new-tab' })
                          setRecentActionError(null)
                          void onOpenFolderInNewTab(folder.path)
                            .catch((reason: unknown) => {
                              setRecentActionError(
                                reason instanceof Error ? reason.message : String(reason),
                              )
                            })
                            .finally(() => setRecentAction(null))
                        }}
                        onRemove={() => {
                          setRecentAction({ path: folder.path, type: 'remove' })
                          setRecentActionError(null)
                          void onRemoveRecentFolder(folder.path)
                            .then(() => setRemovalFocusIndex(index))
                            .catch((reason: unknown) => {
                              setRecentActionError(
                                reason instanceof Error ? reason.message : String(reason),
                              )
                            })
                            .finally(() => setRecentAction(null))
                        }}
                      />
                    </li>
                  )
                })}
              </ul>
            )}

            {recentActionError != null && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {recentActionError}
              </p>
            )}

            {recent.length > 0 && filteredRecent.length === 0 && (
              <p className="mt-4 text-sm text-muted-foreground" role="status">
                No recent folders match “{query.trim()}”.
              </p>
            )}

            {loading && (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                {catalog == null ? 'Loading recent folders…' : 'Refreshing…'}
              </p>
            )}
          </section>
        )}
      </div>
    </ThemedSurface>
  )
}
