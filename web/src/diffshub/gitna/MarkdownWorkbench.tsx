import { useEffect, useMemo, useState, type ComponentProps, type RefObject } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import { IconDiffSplit, IconEye, IconX } from '@pierre/icons'
import remarkGfm from 'remark-gfm'

import { FileHeaderAction } from '../components/DiffsHubViewer'

export type MarkdownViewMode = 'editor' | 'preview' | 'split'

interface MarkdownWorkbenchProps {
  path: string
  value: string | null
  error?: string | null
  markdownMode: MarkdownViewMode
  onMarkdownModeChange(mode: MarkdownViewMode): void
  onOpenPath(path: string): void
  showHeader?: boolean
  onScroll?(scrollTop: number): void
  scrollRef?: RefObject<HTMLDivElement | null>
  sharedScroll?: boolean
}

const MAX_MARKDOWN_BYTES = 512 * 1024

function isSafeLink(value: string): boolean {
  if (value.startsWith('#') || value.startsWith('//')) return !value.startsWith('//')
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return !/^[a-z][a-z\d+.-]*:/i.test(value)
  }
}

function resolveRepositoryPath(source: string, documentPath: string): string | null {
  if (
    source === '' ||
    source.startsWith('#') ||
    source.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(source)
  ) {
    return null
  }
  const base = source.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  const resolved = [...base]
  for (const part of source.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  if (resolved.length === 0 || resolved.some((part) => part === '.git')) return null
  return resolved.join('/')
}

function resolveLocalResource(source: string, documentPath: string): string | null {
  const path = resolveRepositoryPath(source, documentPath)
  return path == null ? null : `api/v1/content?path=${encodeURIComponent(path)}`
}

export function MarkdownWorkbench({
  path,
  value,
  error,
  markdownMode,
  onMarkdownModeChange,
  onOpenPath,
  showHeader = true,
  onScroll,
  scrollRef,
  sharedScroll = false,
}: MarkdownWorkbenchProps) {
  const debouncedValue = useDebouncedValue(value)
  const tooLarge = new TextEncoder().encode(value ?? '').byteLength > MAX_MARKDOWN_BYTES
  const markdown = useMemo(() => (tooLarge ? '' : debouncedValue), [debouncedValue, tooLarge])
  const safeUrlTransform: UrlTransform = (url) => (isSafeLink(url) ? url : '')
  const markdownComponents: Components = {
    a: ({ href, children, ...props }: ComponentProps<'a'>) => (
      <a
        {...props}
        href={href && isSafeLink(href) ? href : undefined}
        onClick={(event) => {
          if (href == null || !isSafeLink(href)) {
            event.preventDefault()
            return
          }
          const localPath = resolveRepositoryPath(href.split(/[?#]/, 1)[0]!, path)
          if (localPath != null) {
            event.preventDefault()
            onOpenPath(localPath)
          }
        }}
        rel={href?.startsWith('http') ? 'noreferrer noopener' : undefined}
        target={href?.startsWith('http') ? '_blank' : undefined}
      >
        {children}
      </a>
    ),
    img: ({ src, alt }: ComponentProps<'img'>) => {
      const localSrc = src == null ? null : resolveLocalResource(src, path)
      return localSrc == null ? (
        <span className="rounded border px-2 py-1 text-xs text-muted-foreground">
          Blocked image resource: {alt ?? 'unnamed'}
        </span>
      ) : (
        <img alt={alt ?? ''} loading="lazy" src={localSrc} />
      )
    },
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Markdown preview">
      {showHeader && (
        <header className="flex min-h-8 shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <span className="mr-auto truncate text-xs font-medium" title={path}>
          {path}
        </span>
        <FileHeaderAction
          type="button"
          aria-label="Open Markdown preview to the side"
          title="Open Markdown preview to the side"
          aria-pressed={markdownMode === 'split'}
          onClick={() => onMarkdownModeChange('split')}
        >
          <IconDiffSplit className="size-3" />
        </FileHeaderAction>
        <FileHeaderAction
          type="button"
          aria-label="Return to Markdown editor"
          title="Return to Markdown editor"
          onClick={() => onMarkdownModeChange('editor')}
        >
          <IconEye className="size-3" />
        </FileHeaderAction>
        <FileHeaderAction
          type="button"
          aria-label="Close Markdown preview"
          title="Close Markdown preview"
          onClick={() => onMarkdownModeChange('editor')}
        >
          <IconX className="size-3" />
        </FileHeaderAction>
        </header>
      )}
      {error == null ? (
        value == null ? (
          <div
            className="grid flex-1 place-items-center text-sm text-muted-foreground"
            role="status"
            aria-busy="true"
          >
            Loading Markdown…
          </div>
        ) : tooLarge ? (
          <div className="m-4 rounded border p-4 text-sm" role="alert">
            Markdown preview is limited to 512 KiB. Open the file in the editor to continue working.
          </div>
        ) : (
          <article
            ref={scrollRef}
            onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
            className={`markdown-preview gitna-scrollbar min-h-0 flex-1 overflow-auto px-4 py-5 text-sm sm:px-6 ${sharedScroll ? 'markdown-preview-shared-scroll' : ''}`}
          >
            <div className="mx-auto w-full max-w-3xl">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                urlTransform={safeUrlTransform}
                components={markdownComponents}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          </article>
        )
      ) : (
        <div
          className="m-4 rounded border border-destructive/40 p-4 text-sm text-destructive"
          role="alert"
        >
          Unable to load this Markdown file: {error}
        </div>
      )}
    </section>
  )
}

function useDebouncedValue(value: string | null): string {
  const [state, setState] = useState(value ?? '')
  useEffect(() => {
    const timer = window.setTimeout(() => setState(value ?? ''), 120)
    return () => window.clearTimeout(timer)
  }, [value])
  return state
}
