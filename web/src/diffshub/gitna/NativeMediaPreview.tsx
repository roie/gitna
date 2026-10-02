import { useEffect, useRef, useState } from 'react'
import { PDFPreview } from './PDFPreview'

export function nativeMediaKind(path: string): 'audio' | 'video' | 'pdf' | null {
  if (/\.pdf$/i.test(path)) return 'pdf'
  if (/\.(wav|mp3|ogg|oga|m4a|flac)$/i.test(path)) return 'audio'
  if (/\.(mp4|m4v|webm|ogv)$/i.test(path)) return 'video'
  return null
}

export function NativeMediaPreview({ path }: { path: string }) {
  const kind = nativeMediaKind(path)
  const source = `api/v1/media?path=${encodeURIComponent(path)}`
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unsupported' | 'missing' | 'error'>(
    'loading',
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (kind === 'pdf') return
    const controller = new AbortController()
    setState('loading')
    void fetch(source, {
      method: 'HEAD',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
      .then((response) => {
        if (controller.signal.aborted) return
        setState(
          response.ok
            ? 'ready'
            : response.status === 415
              ? 'unsupported'
              : response.status === 404
                ? 'missing'
                : 'error',
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error')
      })
    return () => controller.abort()
  }, [source, attempt, kind])

  useEffect(() => {
    const media = mediaRef.current
    return () => {
      // Detached native players can keep playing and fetching byte ranges.
      media?.pause()
      media?.removeAttribute('src')
      media?.load()
    }
  }, [source, state, attempt])

  if (kind === 'pdf') {
    return (
      <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Media preview">
        <PDFPreview path={path} />
      </section>
    )
  }

  const failed = state === 'error' || state === 'missing'
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Media preview">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
        <span className="min-w-0 break-all">{path}</span>
        {!failed && state !== 'loading' && (
          <a
            className="inline-flex min-h-8 shrink-0 items-center underline underline-offset-4"
            href={`${source}&download=1`}
            download
          >
            Download file
          </a>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-4">
        {state === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading media…
          </p>
        ) : failed ? (
          <>
            <p role="alert" className="text-sm text-muted-foreground">
              {state === 'missing'
                ? 'This file no longer exists.'
                : 'Could not load this file. It may have changed or the connection was lost.'}
            </p>
          </>
        ) : state === 'unsupported' ? (
          <p role="status" className="max-w-lg text-center text-sm text-muted-foreground">
            This browser cannot play this file, or the file is damaged. Download it to open it in
            another app.
          </p>
        ) : kind === 'audio' ? (
          <audio
            ref={(element) => {
              mediaRef.current = element
            }}
            src={source}
            controls
            preload="metadata"
            aria-label={`Audio preview: ${path}`}
            className="w-full max-w-xl"
            onError={() => setState('unsupported')}
          />
        ) : (
          <video
            ref={(element) => {
              mediaRef.current = element
            }}
            src={source}
            controls
            preload="metadata"
            playsInline
            aria-label={`Video preview: ${path}`}
            className="max-h-full w-full min-h-0 object-contain"
            onError={() => setState('unsupported')}
          />
        )}
        {(failed || state === 'unsupported') && (
          <button
            className="rounded-md border border-border px-3 py-2 text-sm"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        )}
      </div>
    </section>
  )
}
