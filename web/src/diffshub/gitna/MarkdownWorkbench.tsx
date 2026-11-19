import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import { useMarkdownTheme } from './markdownTheme'
import { renderMarkdownPreview, resolveRepositoryPath } from './markdownPreview'
import { useLoadingIndicator } from '../lib/loading'

export type MarkdownViewMode = 'editor' | 'preview' | 'split'

interface MarkdownWorkbenchProps {
  path: string
  value: string | null
  active?: boolean
  error?: string | null
  onOpenPath: (path: string) => void
  onScroll?: (element: HTMLElement) => void
  scrollRef?: (element: HTMLElement | null) => void
}

const MAX_MARKDOWN_BYTES = 512 * 1024

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
  const theme = useMarkdownTheme()
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [rendered, setRendered] = useState<{ value: string | null; error: string | null }>({
    value: null,
    error: null,
  })
  const enabled = active && value != null && !tooLarge && error == null
  useLayoutEffect(() => {
    if (!enabled || container == null || theme == null) return
    try {
      patchChildren(container, renderMarkdownPreview(debouncedValue, path, theme))
      setRendered({ value: debouncedValue, error: null })
    } catch (renderError) {
      container.replaceChildren()
      setRendered({
        value: debouncedValue,
        error: renderError instanceof Error ? renderError.message : String(renderError),
      })
    }
  }, [enabled, container, debouncedValue, path, theme])
  const rendering = rendered.value !== value
  const loadingVisible = useLoadingIndicator(
    active && error == null && !tooLarge && rendering && rendered.error == null,
    value,
  )

  const onClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as Element
    const copy = target.closest('[data-code-action="copy"]')
    if (copy != null) {
      const code = copy.closest('[data-markdown="code-block"]')?.querySelector('code')?.textContent
      if (code != null) {
        void navigator.clipboard.writeText(code).then(() => {
          copy.textContent = 'Copied'
          window.setTimeout(() => (copy.textContent = 'Copy'), 2000)
        })
      }
      return
    }
    const href = target.closest('a')?.getAttribute('href')
    if (href == null) return
    const localPath = resolveRepositoryPath(href, path)
    if (localPath != null) {
      event.preventDefault()
      openPath(localPath)
    }
  }

  return (
    <section
      className="relative flex h-full min-h-0 flex-col bg-background"
      aria-label="Markdown preview"
    >
      {error == null ? (
        value == null ? (
          <div
            className="grid flex-1 place-items-center text-sm text-muted-foreground"
            role={loadingVisible ? 'status' : undefined}
            aria-busy="true"
          >
            {loadingVisible && 'Loading Markdown…'}
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
            aria-busy={rendering}
            onScroll={(event) => onScroll?.(event.currentTarget)}
            onClick={onClick}
            className="markdown-preview cv-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-5 text-sm sm:px-6"
          >
            <div className="mx-auto w-full max-w-3xl">
              {rendered.error != null && (
                <div role="alert">Unable to render this Markdown file: {rendered.error}</div>
              )}
              <div ref={setContainer} data-markdown="root" />
              {loadingVisible && (
                <div
                  className="absolute inset-bs-0 inset-e-0 bg-background p-2 text-muted-foreground"
                  role="status"
                >
                  Rendering Markdown…
                </div>
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

function patchChildren(container: Element, next: DocumentFragment) {
  const nodes = [...next.childNodes]
  nodes.forEach((node, index) => {
    const current = container.childNodes[index]
    if (current == null) container.append(node)
    else if (!current.isEqualNode(node)) current.replaceWith(node)
  })
  while (container.childNodes.length > nodes.length) container.lastChild?.remove()
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
