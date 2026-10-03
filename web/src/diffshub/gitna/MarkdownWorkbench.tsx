import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
const CachedMarkdown = memo(ReactMarkdown)
const remarkPlugins = [remarkGfm]
const safeUrlTransform: UrlTransform = (url) => (isSafeLink(url) ? url : '')

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
  const markdown = useMemo(() => (tooLarge ? '' : debouncedValue), [debouncedValue, tooLarge])
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
            onScroll={(event) => onScroll?.(event.currentTarget)}
            className="markdown-preview cv-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-5 text-sm sm:px-6"
          >
            <div className="mx-auto w-full max-w-3xl">
              <CachedMarkdown
                remarkPlugins={remarkPlugins}
                skipHtml
                urlTransform={safeUrlTransform}
                components={markdownComponents}
              >
                {markdown}
              </CachedMarkdown>
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
