import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type MarkdownViewMode = 'editor' | 'preview' | 'split'

interface MarkdownWorkbenchProps {
  path: string
  value: string | null
  mode: MarkdownViewMode
  onModeChange(mode: MarkdownViewMode): void
  onChange(value: string): void
  error?: string | null
}

const MAX_MARKDOWN_BYTES = 512 * 1024

function isSafeLink(value: string): boolean {
  if (
    value.startsWith('#') ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../')
  ) {
    return true
  }
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function resolveLocalResource(source: string, documentPath: string): string | null {
  if (!source.startsWith('.') && !source.startsWith('/')) return null
  const base = documentPath.split('/').slice(0, -1).join('/')
  const parts = `${base}/${source}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  if (resolved.some((part) => part === '.git')) return null
  // The content route is intentionally same-origin and path-scoped. It never
  // accepts arbitrary file:// URLs or carries a capability outside this app.
  return `api/v1/content?path=${encodeURIComponent(resolved.join('/'))}`
}

export function MarkdownWorkbench({
  path,
  value,
  mode,
  onModeChange,
  onChange,
  error,
}: MarkdownWorkbenchProps) {
  const [debouncedValue, setDebouncedValue] = useState(value ?? '')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value ?? ''), 120)
    return () => window.clearTimeout(timer)
  }, [value])

  const tooLarge = new TextEncoder().encode(value ?? '').byteLength > MAX_MARKDOWN_BYTES
  const markdown = useMemo(() => (tooLarge ? '' : debouncedValue), [debouncedValue, tooLarge])
  const showEditor = mode !== 'preview'
  const showPreview = mode !== 'editor'

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Markdown document">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2 text-xs">
        <span className="mr-auto truncate font-medium" title={path}>
          {path}
        </span>
        {(['editor', 'preview', 'split'] as const).map((nextMode) => (
          <button
            className={`rounded px-2 py-1 ${mode === nextMode ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60'}`}
            key={nextMode}
            onClick={() => onModeChange(nextMode)}
            type="button"
            aria-pressed={mode === nextMode}
          >
            {nextMode[0].toUpperCase() + nextMode.slice(1)}
          </button>
        ))}
      </div>
      {error == null ? (
        tooLarge ? (
          <div className="m-4 rounded border p-4 text-sm" role="alert">
            This Markdown file is larger than the 512 KiB preview limit. Use the editor or save a
            smaller file.
          </div>
        ) : value == null ? (
          <div
            className="grid flex-1 place-items-center text-sm text-muted-foreground"
            role="status"
            aria-busy="true"
          >
            Loading Markdown…
          </div>
        ) : (
          <div
            className={`grid min-h-0 flex-1 ${mode === 'split' ? 'grid-cols-2 divide-x' : 'grid-cols-1'}`}
          >
            {showEditor && (
              <textarea
                aria-label="Markdown editor"
                className="min-h-0 w-full resize-none overflow-auto bg-transparent p-6 font-mono text-sm leading-6 outline-none"
                onChange={(event) => onChange(event.target.value)}
                spellCheck={false}
                value={value}
              />
            )}
            {showPreview && (
              <article className="gitna-scrollbar min-h-0 overflow-auto px-6 py-5 text-sm leading-7 prose prose-neutral dark:prose-invert max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  urlTransform={(url) => (isSafeLink(url) ? url : '')}
                  components={{
                    a: ({ href, children, ...props }) => (
                      <a
                        {...props}
                        href={href && isSafeLink(href) ? href : undefined}
                        rel={href?.startsWith('http') ? 'noreferrer noopener' : undefined}
                        target={href?.startsWith('http') ? '_blank' : undefined}
                      >
                        {children}
                      </a>
                    ),
                    img: ({ src, alt }) => {
                      const localSrc = src == null ? null : resolveLocalResource(src, path)
                      return localSrc == null ? (
                        <span className="rounded border px-2 py-1 text-xs text-muted-foreground">
                          Blocked image resource: {alt ?? 'unnamed'}
                        </span>
                      ) : (
                        <img alt={alt ?? ''} loading="lazy" src={localSrc} />
                      )
                    },
                  }}
                >
                  {markdown}
                </ReactMarkdown>
              </article>
            )}
          </div>
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
