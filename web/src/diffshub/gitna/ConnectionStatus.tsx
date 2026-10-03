import { useEffect, useRef, useState } from 'react'

import { useRepository, type ConnectionState } from './repository'
import { ToastHost, type Toast } from './ToastHost'

const LABELS: Record<Exclude<ConnectionState, 'connected'>, string> = {
  connecting: 'Connecting to backend…',
  reconnecting: 'Reconnecting…',
  reconciling: 'Refreshing backend state…',
  unreachable: 'Backend unreachable',
  'session-error': 'Backend session error',
}

const SUPPORTING: Record<Exclude<ConnectionState, 'connected'>, string> = {
  connecting: 'Waiting for connection and initial refresh.',
  reconnecting: 'Connection interrupted; shown folder data may be out of date.',
  reconciling: 'Connection is open, but authoritative refresh is not complete.',
  unreachable: 'Retry the connection. If needed, launch Gitna again and open its current URL.',
  'session-error': 'Show this error and open Gitna’s current URL.',
}

function localDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    timestamp,
  )
}

export function connectionStatusDetails(
  state: ConnectionState,
  connectionError: string | null,
  connectionLastSuccessAt: number | null,
  hasSnapshot: boolean,
): { details: string[]; label: string | null } {
  if (state === 'connected') return { label: null, details: [] }
  const details = [SUPPORTING[state]]
  if (connectionError != null) details.push(connectionError)
  if (connectionLastSuccessAt != null) {
    details.push(
      `Last refreshed ${localDateTime(connectionLastSuccessAt)} · folder data may be out of date.`,
    )
  } else if (hasSnapshot) {
    details.push('Shown folder data is not yet verified.')
  }
  if (state === 'unreachable' || state === 'session-error') {
    details.push('Keep this tab open or copy unsaved edits before reopening.')
  }
  return { label: LABELS[state], details }
}

export function GlobalToastHost({
  actionError,
  onDismissActionError,
}: {
  actionError: string | null
  onDismissActionError(): void
}) {
  const repository = useRepository()
  const previousState = useRef(repository.connectionState)
  const [connectionIncident, setConnectionIncident] = useState(false)
  const [retryAvailable, setRetryAvailable] = useState(false)
  const [retryPending, setRetryPending] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const state = repository.connectionState
  const connectionFailure = state === 'unreachable' || state === 'session-error'

  useEffect(() => {
    const previous = previousState.current
    if (previous !== state) {
      setAnnouncement(
        state === 'connected'
          ? 'Backend connection restored.'
          : `${LABELS[state]} ${SUPPORTING[state]}`,
      )
      if (state === 'connected') {
        setConnectionIncident(false)
        setRetryAvailable(false)
        setRetryPending(false)
        setDismissed(false)
      } else if (connectionFailure || (previous === 'connected' && state === 'reconnecting')) {
        setConnectionIncident(true)
        if (connectionFailure) setRetryAvailable(true)
        if (!connectionIncident) setDismissed(false)
      }
    }
    previousState.current = state
  }, [connectionFailure, state])

  const retry = () => {
    if (retryPending) return
    setRetryPending(true)
    void repository.retryConnection().finally(() => {
      if (repository.connectionState !== 'connected') setRetryPending(false)
    })
  }
  const connectionVisible = connectionIncident && !dismissed
  const toasts: Toast[] = []

  if (connectionVisible) {
    toasts.push({
      id: 'connection',
      dataState: state,
      title: state === 'session-error' ? 'Session unavailable' : 'Connection interrupted',
      description:
        state === 'session-error'
          ? `${repository.connectionError ?? 'Open Gitna’s current URL.'} Keep this tab open to retain unsaved edits.`
          : 'Trying to reconnect. Keep this tab open to retain unsaved edits.',
      onDismiss: () => setDismissed(true),
      severity: 'warning',
      action: retryAvailable
        ? { disabled: retryPending, label: retryPending ? 'Retrying…' : 'Retry', onClick: retry }
        : undefined,
    })
  }

  if (actionError != null) {
    toasts.push({
      id: 'action-error',
      title: actionError,
      onDismiss: onDismissActionError,
      severity: 'error',
    })
  }

  return (
    <>
      <span
        role={
          state !== 'connected' ||
          (repository.snapshot?.repository === true &&
            (typeof document === 'undefined' ||
              document.querySelector('section[role="status"]') == null))
            ? 'status'
            : undefined
        }
        data-connection-state={state}
        aria-live="polite"
        className="sr-only"
      >
        <span data-connection-announcement>{announcement}</span>
      </span>
      <ToastHost toasts={toasts} />
    </>
  )
}
