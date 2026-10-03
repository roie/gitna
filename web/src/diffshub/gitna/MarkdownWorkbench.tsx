import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import type { Components } from 'react-markdown'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { MarkdownTree } from './markdownParser'
import { MarkdownWorkerClient } from './markdownWorkerClient'

export type MarkdownViewMode = 'editor' | 'preview' | 'split'

interface MarkdownWorkbenchProps {
  path: string
  value: string | null
  active?: boolean
  error?: string | null
  onOpenPath(path: string): void
  onScroll?(element: HTMLElement): void
  scrollRef?: (element: HTMLElement | null) => void
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
  const pathname = source.split(/[?#]/, 1)[0]!
  const base = pathname.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  const resolved = [...base]
  for (const part of pathname.split('/')) {
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
  active = true,
  error,
  onOpenPath,
  onScroll,
  scrollRef,
}: MarkdownWorkbenchProps) {
  const openPath = useStableCallback(onOpenPath)
  const debouncedValue = useDebouncedValue(value, active)
  const tooLarge = useMemo(
    () => new TextEncoder().encode(value ?? '').byteLength > MAX_MARKDOWN_BYTES,
    [value],
  )
  const markdown = tooLarge ? '' : debouncedValue
  const parsed = useParsedMarkdown(markdown, active && value != null && !tooLarge && error == null)
  const markdownComponents = useMemo<Components>(
    () => ({
      h1: ({ node, ...props }) => <h1 {...props} data-source-line={node?.position?.start.line} />,
      h2: ({ node, ...props }) => <h2 {...props} data-source-line={node?.position?.start.line} />,
      h3: ({ node, ...props }) => <h3 {...props} data-source-line={node?.position?.start.line} />,
      h4: ({ node, ...props }) => <h4 {...props} data-source-line={node?.position?.start.line} />,
      h5: ({ node, ...props }) => <h5 {...props} data-source-line={node?.position?.start.line} />,
      h6: ({ node, ...props }) => <h6 {...props} data-source-line={node?.position?.start.line} />,
      p: ({ node, ...props }) => <p {...props} data-source-line={node?.position?.start.line} />,
      li: ({ node, ...props }) => <li {...props} data-source-line={node?.position?.start.line} />,
      pre: ({ node, ...props }) => <pre {...props} data-source-line={node?.position?.start.line} />,
      blockquote: ({ node, ...props }) => (
        <blockquote {...props} data-source-line={node?.position?.start.line} />
      ),
      table: ({ node, ...props }) => (
        <table {...props} data-source-line={node?.position?.start.line} />
      ),
      a: ({ href, children, ...props }: ComponentProps<'a'>) => (
        <a
          {...props}
          href={href && isSafeLink(href) ? href : undefined}
          onClick={(event) => {
            if (href == null || !isSafeLink(href)) {
              event.preventDefault()
              return
            }
            const localPath = resolveRepositoryPath(href, path)
            if (localPath != null) {
              event.preventDefault()
              openPath(localPath)
            }
          }}
          rel={/^https?:/i.test(href ?? '') ? 'noreferrer noopener' : undefined}
          target={/^https?:/i.test(href ?? '') ? '_blank' : undefined}
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
    }),
    [path, openPath],
  )

  const rendered = useMemo(
    () =>
      parsed.tree == null
        ? null
        : toJsxRuntime(parsed.tree, {
            Fragment,
            jsx,
            jsxs,
            components: markdownComponents,
            passNode: true,
          }),
    [parsed.tree, markdownComponents],
  )

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Markdown preview">
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
            tabIndex={0}
            aria-label="Rendered Markdown"
            aria-busy={parsed.loading}
            onScroll={(event) => onScroll?.(event.currentTarget)}
            className="markdown-preview cv-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-5 text-sm sm:px-6"
          >
            <div className="mx-auto w-full max-w-3xl">
              {parsed.error != null ? (
                <div role="alert">Unable to render this Markdown file: {parsed.error}</div>
              ) : parsed.loading ? (
                <div role="status">Rendering Markdown…</div>
              ) : (
                rendered
              )}
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

function useParsedMarkdown(value: string, enabled: boolean) {
  const client = useRef<MarkdownWorkerClient | null>(null)
  const [state, setState] = useState<{
    value: string | null
    tree: MarkdownTree | null
    error: string | null
  }>({ value: null, tree: null, error: null })

  useEffect(
    () => () => {
      client.current?.dispose()
      client.current = null
    },
    [enabled],
  )

  useEffect(() => {
    if (!enabled || state.value === value) return
    let current = true
    const fail = (error: unknown) => {
      if (!current) return
      setState({ value, tree: null, error: error instanceof Error ? error.message : String(error) })
      client.current?.dispose()
      client.current = null
    }
    try {
      client.current ??= new MarkdownWorkerClient(
        new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' }),
      )
      void client.current.parse(value).then((tree) => {
        if (current) setState({ value, tree, error: null })
      }, fail)
    } catch (error) {
      fail(error)
    }
    return () => {
      current = false
    }
  }, [value, enabled, state.value])

  return { ...state, loading: state.value !== value }
}

function useDebouncedValue(value: string | null, active: boolean): string {
  const [state, setState] = useState(value ?? '')
  const wasActive = useRef(active)
  useLayoutEffect(() => {
    // Reopening must paint the current revision, not a hidden stale preview.
    if (active && !wasActive.current) setState(value ?? '')
    wasActive.current = active
  }, [active, value])
  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => setState(value ?? ''), 120)
    return () => window.clearTimeout(timer)
  }, [value, active])
  return state
}
