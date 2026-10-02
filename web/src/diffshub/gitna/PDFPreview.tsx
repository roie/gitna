import { useEffect, useState } from 'react'

interface PDFLease {
  token: string
  url: string
  expiresAt: string
}

export function PDFPreview({ path, standalone = false }: { path: string; standalone?: boolean }) {
  const [attempt, setAttempt] = useState(0)
  const [url, setURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (standalone) document.title = `${path.split('/').pop()} — Gitna`
  }, [path, standalone])

  useEffect(() => {
    setURL(null)
    setError(null)
    if (navigator.pdfViewerEnabled === false) {
      setError('This browser cannot display PDFs. Download the file to open it in your PDF reader.')
      return
    }
    // Capture the folder-scoped URL before a navigation can change the base.
    const endpoint = new URL('api/v1/pdf-preview', window.location.href).href
    let active = true
    let lease: PDFLease | null = null
    let renewTimer: ReturnType<typeof setInterval> | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const release = (token: string) => {
      void fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => {})
    }
    const stop = () => {
      active = false
      clearInterval(renewTimer)
      clearTimeout(expiryTimer)
      if (lease != null) {
        release(lease.token)
        lease = null
      }
    }
    const expire = () => {
      if (!active) return
      stop()
      setURL(null)
      setError('This preview expired. Reload it to continue.')
    }
    const armExpiry = (expiresAt: string) => {
      clearTimeout(expiryTimer)
      expiryTimer = setTimeout(expire, Math.max(0, Date.parse(expiresAt) - Date.now()))
    }
    const renew = async () => {
      if (!active || lease == null) return
      try {
        const response = await fetch(`${endpoint}?token=${encodeURIComponent(lease.token)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        })
        if (!active) return
        if (response.status === 404) {
          expire()
          return
        }
        if (response.ok) {
          const refreshed = (await response.json()) as PDFLease
          if (active) armExpiry(refreshed.expiresAt)
        }
      } catch {
        // Keep the current page during a brief disconnection, but never extend
        // the lease locally without an acknowledgment from the app server.
      }
    }
    void fetch(`${endpoint}?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (response) => {
        if (!response.ok) {
          if (active)
            setError(
              response.status === 404
                ? 'This file no longer exists.'
                : 'PDF preview is unavailable. Reload it or download the file to open it locally.',
            )
          return
        }
        const created = (await response.json()) as PDFLease
        // A tab can close while the server is creating its capability.
        if (!active) {
          release(created.token)
          return
        }
        lease = created
        setURL(created.url)
        armExpiry(created.expiresAt)
        renewTimer = setInterval(() => {
          void renew()
        }, 60_000)
      })
      .catch(() => {
        if (active)
          setError('Could not load the PDF. Check your connection and reload the preview.')
      })
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setAttempt((value) => value + 1)
    }
    window.addEventListener('pagehide', stop)
    window.addEventListener('pageshow', restore)
    return () => {
      window.removeEventListener('pagehide', stop)
      window.removeEventListener('pageshow', restore)
      stop()
    }
  }, [path, attempt])

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {error != null ? (
        <p role="status" className="m-auto max-w-lg p-4 text-center text-sm text-muted-foreground">
          {error}
        </p>
      ) : url == null ? (
        <p role="status" className="m-auto p-4 text-sm text-muted-foreground">
          Loading PDF…
        </p>
      ) : (
        // Native PDF plugins do not run in sandboxed iframes. This URL belongs
        // to a separate PDF-only origin, never the privileged application.
        <iframe
          title={`PDF preview: ${path}`}
          src={url}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0"
        />
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {!standalone && (
          <a
            className="inline-flex min-h-8 items-center underline underline-offset-4"
            href={`?pdf=${encodeURIComponent(path)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open PDF in new tab ↗
          </a>
        )}
        {(url == null || error != null) && (
          <a
            className="inline-flex min-h-8 items-center underline underline-offset-4"
            href={`api/v1/media?path=${encodeURIComponent(path)}&download=1`}
            download
          >
            Download file
          </a>
        )}
        <button
          className="min-h-8 shrink-0 underline underline-offset-4"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Reload PDF preview
        </button>
      </div>
    </div>
  )
}
