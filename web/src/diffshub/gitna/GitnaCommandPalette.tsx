import { IconSearch } from '@pierre/icons'
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { FileX, LoaderCircle } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'

import { cn } from '../lib/cn'
import { splitPaletteFileMatchIndices, paletteTextMatches } from './commandPalette'

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

function HighlightedText({
  text,
  matchIndices,
}: {
  text: string
  matchIndices: ReadonlySet<number>
}) {
  const characters = Array.from(text)
  const runs: { highlighted: boolean; start: number; text: string }[] = []
  for (const [index, character] of characters.entries()) {
    const highlighted = matchIndices.has(index)
    const previous = runs.at(-1)
    if (previous?.highlighted === highlighted) {
      previous.text += character
    } else {
      runs.push({ highlighted, start: index, text: character })
    }
  }
  return runs.map((run) =>
    run.highlighted ? (
      <span key={run.start} data-palette-match className="text-blue-600 dark:text-blue-400">
        {run.text}
      </span>
    ) : (
      <Fragment key={run.start}>{run.text}</Fragment>
    ),
  )
}

function MiddleTruncatedHighlightedText({
  text,
  matchIndices,
}: {
  text: string
  matchIndices: ReadonlySet<number>
}) {
  const characters = Array.from(text)
  if (characters.length <= 24) {
    return (
      <span className="min-w-0 truncate">
        <HighlightedText text={text} matchIndices={matchIndices} />
      </span>
    )
  }
  const suffixLength = Math.min(12, Math.max(1, Math.floor(characters.length / 2)))
  const split = characters.length - suffixLength
  const prefixMatches = new Set([...matchIndices].filter((index) => index < split))
  const suffixMatches = new Set(
    [...matchIndices].filter((index) => index >= split).map((index) => index - split),
  )
  return (
    <>
      <span
        data-palette-file-name-prefix
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
      >
        <HighlightedText text={characters.slice(0, split).join('')} matchIndices={prefixMatches} />
      </span>
      <span
        data-palette-file-name-suffix
        className="max-w-1/2 shrink-0 overflow-hidden whitespace-nowrap text-right [direction:rtl]"
      >
        <bdi dir="ltr">
          <HighlightedText text={characters.slice(split).join('')} matchIndices={suffixMatches} />
        </bdi>
      </span>
    </>
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
  matchIndices?: readonly number[]
  name: string
  parent: string
  path: string
}

interface GitnaCommandPaletteProps {
  commands: readonly GitnaPaletteCommand[]
  externalFileResults: readonly GitnaPaletteFileResult[]
  fileSearchComplete: boolean
  fileResultIncludeIgnored: boolean
  fileResultQuery: string | null
  folderLabel: string
  error: string | null
  searching: boolean
  supportsIgnoredFiles: boolean
  onClose(): void
  onError(error: string): void
  onFileQueryChange(query: string, includeIgnored: boolean): void
  onOpenFile(path: string): void
  open: boolean
}

type PaletteResult =
  | { id: string; kind: 'command'; command: GitnaPaletteCommand }
  | {
      id: string
      kind: 'file'
      matchIndices: readonly number[]
      name: string
      parent: string
      path: string
      stale: boolean
    }

type PaletteFileResult = Extract<PaletteResult, { kind: 'file' }>

function paletteFileParentLabel(parent: string, folderLabel: string): string {
  if (parent !== '') return `${parent}/`
  return folderLabel.endsWith('/') ? folderLabel : `${folderLabel}/`
}

function PaletteFileLabel({
  result,
  folderLabel,
}: {
  result: PaletteFileResult
  folderLabel: string
}) {
  const displayParent = paletteFileParentLabel(result.parent, folderLabel)
  const matches = splitPaletteFileMatchIndices(
    result.path,
    result.name,
    result.parent,
    result.matchIndices,
  )
  return (
    <span
      data-palette-file-label
      className="flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap"
    >
      <span
        data-palette-file-name
        className="flex max-w-[55%] min-w-0 shrink-0 overflow-hidden text-sm"
      >
        <MiddleTruncatedHighlightedText text={result.name} matchIndices={matches.name} />
      </span>
      <span
        data-palette-file-parent
        className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground [direction:rtl]"
      >
        <bdi dir="ltr">
          <HighlightedText text={displayParent} matchIndices={matches.parent} />
        </bdi>
      </span>
    </span>
  )
}

export function GitnaCommandPalette({
  commands,
  error,
  externalFileResults,
  fileSearchComplete,
  fileResultIncludeIgnored,
  fileResultQuery,
  folderLabel,
  searching,
  supportsIgnoredFiles,
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
  const [includeIgnored, setIncludeIgnored] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const commandMode = query.trimStart().startsWith('>')
  const commandQuery = commandMode ? query.trimStart().slice(1).trim() : ''
  const fileRequestKey = `${includeIgnored ? '1' : '0'}\u0000${query}`

  const fileResultsCurrent =
    fileResultQuery === query && fileResultIncludeIgnored === includeIgnored
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
    return externalFileResults.map((file) => ({
      id: `file:${file.path}`,
      kind: 'file',
      matchIndices: file.matchIndices ?? [],
      name: file.name,
      parent: file.parent,
      path: file.path,
      stale: !fileResultsCurrent,
    }))
  }, [commandMode, commandQuery, commands, externalFileResults, fileResultsCurrent])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || dialog == null) return
    setQuery('')
    setIncludeIgnored(true)
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
    const repeatedQuery = lastRequestedFileQueryRef.current === fileRequestKey
    if (repeatedQuery && ((fileResultsCurrent && fileSearchComplete) || searching || error != null))
      return
    const timer = window.setTimeout(
      () => {
        lastRequestedFileQueryRef.current = fileRequestKey
        onFileQueryChange(query, includeIgnored)
      },
      repeatedQuery ? 500 : 100,
    )
    return () => window.clearTimeout(timer)
  }, [
    commandMode,
    error,
    fileRequestKey,
    fileResultsCurrent,
    fileSearchComplete,
    includeIgnored,
    onFileQueryChange,
    open,
    query,
    searching,
  ])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const execute = (result: PaletteResult | undefined) => {
    if (result == null || (result.kind === 'file' && result.stale)) return
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

  const fileSearchErrorCurrent =
    !commandMode && error != null && lastRequestedFileQueryRef.current === fileRequestKey
  const fileSearchBusy =
    !commandMode &&
    (searching || (!fileSearchErrorCurrent && (!fileResultsCurrent || !fileSearchComplete)))

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
        {fileSearchBusy && (
          <span className="flex shrink-0 items-center text-muted-foreground" role="status">
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none"
            />
            <span className="sr-only">{searching ? 'Searching files' : 'Scanning folder'}</span>
          </span>
        )}
        {!commandMode && supportsIgnoredFiles && (
          <button
            type="button"
            aria-label={includeIgnored ? 'Exclude Ignored Files' : 'Include Ignored Files'}
            aria-pressed={includeIgnored}
            title={includeIgnored ? 'Exclude Ignored Files' : 'Include Ignored Files'}
            className={cn(
              'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              includeIgnored && 'bg-muted text-foreground',
            )}
            onClick={() => {
              setIncludeIgnored((current) => !current)
              setActiveIndex(0)
            }}
          >
            <FileX aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={commandMode ? 'Commands' : 'Files'}
        aria-busy={fileSearchBusy}
        className="gitna-scrollbar max-h-[min(560px,calc(84dvh-58px))] overflow-y-auto overscroll-contain p-1.5"
      >
        {results.map((result, index) => (
          <button
            key={result.id}
            id={`${listboxId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            aria-disabled={result.kind === 'file' && result.stale ? true : undefined}
            aria-label={
              result.kind === 'file'
                ? `${result.name} ${paletteFileParentLabel(result.parent, folderLabel)}`
                : undefined
            }
            data-palette-index={index}
            tabIndex={-1}
            className={cn(
              'flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
              index === activeIndex && 'bg-muted',
              result.kind === 'file' &&
                result.stale &&
                'cursor-default opacity-55 hover:bg-transparent',
            )}
            onClick={() => execute(result)}
            onPointerMove={() => {
              if (result.kind !== 'file' || !result.stale) setActiveIndex(index)
            }}
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
            {result.kind === 'file' ? (
              <PaletteFileLabel result={result} folderLabel={folderLabel} />
            ) : (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{result.command.label}</span>
                {result.command.description != null && (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {result.command.description}
                  </span>
                )}
              </span>
            )}
          </button>
        ))}

        {fileSearchErrorCurrent && !searching && (
          <div className="px-3 py-4 text-center" role="alert">
            <p className="text-sm font-medium">Could not search files</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          </div>
        )}
        {results.length === 0 &&
          (commandMode ||
            (fileResultsCurrent && fileSearchComplete && !searching && error == null)) && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">
              {commandMode ? 'No commands match.' : 'No files match.'}
            </p>
          )}
      </div>
    </dialog>
  )
}
