import { IconFile, IconSearch } from '@pierre/icons'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { cn } from '../lib/cn'
import { rankPaletteFiles, paletteTextMatches } from './commandPalette'

export interface GitnaPaletteCommand {
  description?: string
  id: string
  keywords?: string
  label: string
  run(): Promise<void> | void
}

interface GitnaCommandPaletteProps {
  commands: readonly GitnaPaletteCommand[]
  error: string | null
  loading: boolean
  onClose(): void
  onError(error: string): void
  onOpenFile(path: string): void
  open: boolean
  openPaths: readonly string[]
  paths: readonly string[]
}

type PaletteResult =
  | { id: string; kind: 'command'; command: GitnaPaletteCommand }
  | {
      id: string
      kind: 'file'
      duplicateName: boolean
      name: string
      parent: string
      path: string
    }

export function GitnaCommandPalette({
  commands,
  error,
  loading,
  onClose,
  onError,
  onOpenFile,
  open,
  openPaths,
  paths,
}: GitnaCommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const commandMode = query.trimStart().startsWith('>')
  const commandQuery = commandMode ? query.trimStart().slice(1).trim() : ''

  const results = useMemo<PaletteResult[]>(() => {
    if (commandMode) {
      return commands
        .filter((command) =>
          paletteTextMatches(
            `${command.label}\n${command.description ?? ''}\n${command.keywords ?? ''}`,
            commandQuery,
          ),
        )
        .slice(0, 100)
        .map((command) => ({ id: `command:${command.id}`, kind: 'command', command }))
    }
    return rankPaletteFiles(paths, query, openPaths).map((file) => ({
      id: `file:${file.path}`,
      kind: 'file',
      duplicateName: file.duplicateName,
      name: file.name,
      parent: file.parent,
      path: file.path,
    }))
  }, [commandMode, commandQuery, commands, openPaths, paths, query])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || dialog == null) return
    setQuery('')
    setActiveIndex(0)
    if (!dialog.open) dialog.showModal()
    queueMicrotask(() => inputRef.current?.focus())
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, results.length - 1)))
  }, [results.length])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const execute = (result: PaletteResult | undefined) => {
    if (result == null) return
    onClose()
    try {
      const operation = result.kind === 'file' ? onOpenFile(result.path) : result.command.run()
      void Promise.resolve(operation).catch((reason: unknown) =>
        onError(reason instanceof Error ? reason.message : String(reason)),
      )
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      className="fixed inset-x-0 top-[8dvh] m-0 mx-auto max-h-[min(660px,84dvh)] w-[min(680px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-none backdrop:bg-black/45 md:top-[12dvh]"
      style={{ boxShadow: 'none' }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <IconSearch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-activedescendant={results[activeIndex]?.id}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-label="Search files and commands"
          autoComplete="off"
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="Search files or type > for commands"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setActiveIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (results.length === 0) return
              event.preventDefault()
              setActiveIndex(
                (current) =>
                  (current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
                  results.length,
              )
            } else if (event.key === 'Home' || event.key === 'End') {
              if (results.length === 0) return
              event.preventDefault()
              setActiveIndex(event.key === 'Home' ? 0 : results.length - 1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              execute(results[activeIndex])
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />
        <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">
          Esc
        </kbd>
      </div>

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={commandMode ? 'Commands' : 'Files'}
        className="max-h-[min(560px,calc(84dvh-58px))] overflow-y-auto overscroll-contain p-1.5"
      >
        {results.map((result, index) => (
          <button
            key={result.id}
            id={result.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            data-palette-index={index}
            className={cn(
              'flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
              index === activeIndex && 'bg-muted',
            )}
            onClick={() => execute(result)}
            onPointerMove={() => setActiveIndex(index)}
          >
            {result.kind === 'file' ? (
              <IconFile aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <IconSearch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {result.kind === 'file' ? result.name : result.command.label}
              </span>
              {(result.kind === 'file'
                ? result.parent !== ''
                : result.command.description != null) && (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {result.kind === 'file'
                    ? result.duplicateName
                      ? result.parent
                      : result.path
                    : result.command.description}
                </span>
              )}
            </span>
          </button>
        ))}

        {results.length === 0 && !commandMode && loading && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">
            Loading files…
          </p>
        )}
        {results.length === 0 && !commandMode && !loading && error != null && (
          <div className="px-3 py-8 text-center" role="alert">
            <p className="text-sm font-medium">Could not search files</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          </div>
        )}
        {results.length === 0 && (commandMode || (!loading && error == null)) && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">
            {commandMode ? 'No commands match.' : 'No files match.'}
          </p>
        )}
        {results.length > 0 && !commandMode && loading && (
          <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
            Refreshing file list…
          </p>
        )}
      </div>
    </dialog>
  )
}
