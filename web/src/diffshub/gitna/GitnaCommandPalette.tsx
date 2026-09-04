import { IconSearch } from '@pierre/icons'
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'

import { cn } from '../lib/cn'
import { paletteTextMatches } from './commandPalette'

const paletteFileIconResolver = createFileTreeIconResolver('complete')
const paletteFileIconSprite = getBuiltInSpriteSheet('complete')

function PaletteFileIconSprite() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host == null) return
    const parsed = new DOMParser().parseFromString(paletteFileIconSprite, 'text/html')
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

function PaletteFileIcon({ path }: { path: string }) {
  const icon = paletteFileIconResolver.resolveIcon('file-tree-icon-file', path)
  const iconHref = `#${icon.name.replace(/^#/, '')}`
  const iconViewBox = icon.viewBox ?? `0 0 ${String(icon.width ?? 16)} ${String(icon.height ?? 16)}`
  return (
    <svg
      aria-hidden="true"
      data-palette-file-icon
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
  )
}

export interface GitnaPaletteCommand {
  description?: string
  icon: ReactNode
  id: string
  keywords?: string
  label: string
  run(): Promise<void> | void
}

export interface GitnaPaletteFileResult {
  duplicateName: boolean
  name: string
  parent: string
  path: string
}

interface GitnaCommandPaletteProps {
  commands: readonly GitnaPaletteCommand[]
  externalFileResults: readonly GitnaPaletteFileResult[]
  fileSearchComplete: boolean
  fileResultQuery: string | null
  error: string | null
  loading: boolean
  onClose(): void
  onError(error: string): void
  onFileQueryChange(query: string): void
  onOpenFile(path: string): void
  open: boolean
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
  externalFileResults,
  fileSearchComplete,
  fileResultQuery,
  loading,
  onClose,
  onError,
  onFileQueryChange,
  onOpenFile,
  open,
}: GitnaCommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lastRequestedFileQueryRef = useRef<string | null>(null)
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
    if (fileResultQuery !== query) return []
    return externalFileResults.map((file) => ({
      id: `file:${file.path}`,
      kind: 'file',
      duplicateName: file.duplicateName,
      name: file.name,
      parent: file.parent,
      path: file.path,
    }))
  }, [commandMode, commandQuery, commands, externalFileResults, fileResultQuery, query])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || dialog == null) return
    setQuery('')
    setActiveIndex(0)
    lastRequestedFileQueryRef.current = null
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
    if (!open || commandMode) return
    const repeatedQuery = lastRequestedFileQueryRef.current === query
    if (repeatedQuery && (fileSearchComplete || loading)) return
    const timer = window.setTimeout(
      () => {
        lastRequestedFileQueryRef.current = query
        onFileQueryChange(query)
      },
      repeatedQuery ? 500 : 35,
    )
    return () => window.clearTimeout(timer)
  }, [
    commandMode,
    externalFileResults,
    fileSearchComplete,
    loading,
    onFileQueryChange,
    open,
    query,
  ])

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
      <PaletteFileIconSprite />
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <IconSearch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-activedescendant={
            results[activeIndex] == null ? undefined : `${listboxId}-option-${activeIndex}`
          }
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
        className="gitna-scrollbar max-h-[min(560px,calc(84dvh-58px))] overflow-y-auto overscroll-contain p-1.5"
      >
        {results.map((result, index) => (
          <button
            key={result.id}
            id={`${listboxId}-option-${index}`}
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
              <PaletteFileIcon path={result.path} />
            ) : (
              <span
                aria-hidden="true"
                data-palette-command-icon={result.command.id}
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4"
              >
                {result.command.icon}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {result.kind === 'file' ? result.name : result.command.label}
              </span>
              {(result.kind === 'file' || result.command.description != null) && (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {result.kind === 'file'
                    ? result.parent === ''
                      ? 'Repository root'
                      : result.duplicateName
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
