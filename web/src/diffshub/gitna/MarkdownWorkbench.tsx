import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Button } from '../components/Button'
import type { GitnaEditorActions } from '../components/DiffsHubViewer'

export type MarkdownViewMode = 'editor' | 'preview' | 'split'

interface MarkdownWorkbenchProps {
  path: string
  value: string | null
  mode: MarkdownViewMode
  onModeChange(mode: MarkdownViewMode): void
  onChange(value: string): void
  error?: string | null
  editorActions?: GitnaEditorActions
  onOpenPath(path: string): void
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
  const resolved: string[] = [...base]
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
  if (path == null) return null
  return `api/v1/content?path=${encodeURIComponent(path)}`
}

export function MarkdownWorkbench({
  path,
  value,
  mode,
  onModeChange,
  onChange,
  error,
  editorActions,
  onOpenPath,
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
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Markdown document">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2 text-xs">
        <span className="mr-auto truncate font-medium" title={path}>
          {path}
        </span>
        {editorActions != null && (
          <>
            {editorActions.changeScopes(path).length > 0 && (
              <Button
                onClick={() =>
                  editorActions.onOpenChange(editorActions.changeScopes(path)[0]!, path)
                }
                size="xs"
                type="button"
                variant="ghost"
              >
                View Changes
              </Button>
            )}
            <Button
              disabled={
                !editorActions.dirtyPaths.has(path) ||
                editorActions.saving ||
                editorActions.disabledReason != null
              }
              onClick={() => editorActions.onSave(path)}
              size="xs"
              title={editorActions.disabledReason ?? undefined}
              type="button"
              variant="ghost"
            >
              {editorActions.saving
                ? 'Saving…'
                : editorActions.dirtyPaths.has(path)
                  ? 'Save'
                  : 'Saved'}
            </Button>
          </>
        )}
        <div
          className="flex items-center rounded-md border bg-muted/30 p-0.5"
          role="group"
          aria-label="Markdown view mode"
        >
          {(['editor', 'preview', 'split'] as const).map((nextMode) => (
            <Button
              aria-pressed={mode === nextMode}
              key={nextMode}
              onClick={() => onModeChange(nextMode)}
              size="xs"
              type="button"
              variant={mode === nextMode ? 'secondary' : 'ghost'}
            >
              {nextMode[0].toUpperCase() + nextMode.slice(1)}
            </Button>
          ))}
        </div>
      </div>
      {error == null ? (
        tooLarge && mode !== 'editor' ? (
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
                className="min-h-0 w-full resize-none overflow-auto border-0 bg-transparent p-6 font-mono text-sm leading-6 outline-none focus:ring-0"
                onChange={(event) => onChange(event.target.value)}
                spellCheck={false}
                value={value}
              />
            )}
            {showPreview && (
              <article className="markdown-preview gitna-scrollbar min-h-0 overflow-auto px-6 py-5 text-sm">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  urlTransform={safeUrlTransform}
                  components={markdownComponents}
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
