import { useEffect, useState } from 'react'
import { useLoadingIndicator } from '../lib/loading'

const MAX_SVG_BYTES = 512 * 1024

export function SVGPreview({ value, active }: { value: string | null; active: boolean }) {
  const [source, setSource] = useState<{ value: string; url: string } | null>(null)
  const [failedURL, setFailedURL] = useState<string | null>(null)
  const tooLarge =
    value != null &&
    (value.length > MAX_SVG_BYTES || new TextEncoder().encode(value).byteLength > MAX_SVG_BYTES)

  useEffect(() => {
    if (!active || value == null || tooLarge) return
    const timer = window.setTimeout(() => {
      setSource({
        value,
        url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.toWellFormed())}`,
      })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [active, value, tooLarge])

  const pending = value == null || source?.value !== value
  const loadingVisible = useLoadingIndicator(active && !tooLarge && pending, value)
  const message = tooLarge
    ? 'SVG preview is limited to 512 KiB. You can still edit the source.'
    : value == null
      ? loadingVisible
        ? 'Loading SVG…'
        : null
      : source?.value !== value
        ? loadingVisible
          ? 'Updating SVG preview…'
          : null
        : failedURL === source.url
          ? 'The browser could not display this SVG. Check the source for invalid or unsupported content.'
          : null

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="SVG preview">
      {value == null ? (
        <div
          className="grid flex-1 place-items-center text-sm text-muted-foreground"
          role={loadingVisible ? 'status' : undefined}
          aria-busy="true"
        >
          {message}
        </div>
      ) : tooLarge ? (
        <div className="m-4 rounded border p-4 text-sm" role="alert">
          {message}
        </div>
      ) : (
        <article
          className="markdown-preview cv-scrollbar relative min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-5 text-sm sm:px-6"
          tabIndex={0}
          aria-label="Rendered SVG"
          aria-busy={source?.value !== value}
        >
          <div className="mx-auto w-full max-w-3xl">
            {message != null ? (
              <div
                className={
                  pending
                    ? 'absolute inset-bs-0 inset-e-0 bg-background p-2 text-muted-foreground'
                    : undefined
                }
                role={!pending && failedURL === source?.url ? 'alert' : 'status'}
              >
                {message}
              </div>
            ) : null}
            {!tooLarge && source != null && failedURL !== source.url && (
              <img src={source.url} alt="SVG preview" onError={() => setFailedURL(source.url)} />
            )}
          </div>
        </article>
      )}
    </section>
  )
}
