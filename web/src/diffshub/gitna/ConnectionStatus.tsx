import { IconChevronSm, IconRefresh } from '@pierre/icons'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../components/Button'
import { useRepository, type ConnectionState } from './repository'

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

export function ConnectionStatus() {
  const repository = useRepository()
  const previousState = useRef(repository.connectionState)
  const statusHadFocus = useRef(false)
  const [refreshAcknowledgment, setRefreshAcknowledgment] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const state = repository.connectionState
  const unavailable = state !== 'connected'
  const recoveringWithFocus =
    state === 'connected' && previousState.current !== 'connected' && statusHadFocus.current

  useEffect(() => {
    if (previousState.current !== state) {
      setAnnouncement(
        state === 'connected'
          ? 'Backend connection restored.'
          : `${LABELS[state]} ${SUPPORTING[state]}`,
      )
    }
    if (state === 'connected' && previousState.current !== 'connected') {
      // Keep the focused summary or Retry button mounted through the recovery
      // render. The acknowledgement is dismissed by leaving this section,
      // rather than by a timer that can race with keyboard navigation.
      if (statusHadFocus.current) setRefreshAcknowledgment(true)
    }
    previousState.current = state
  }, [state])

  const retry = () => {
    void repository.retryConnection().catch(() => undefined)
  }
  const descriptionId = 'gitna-connection-status-description'
  const statusDetails = connectionStatusDetails(
    state,
    repository.connectionError,
    repository.connectionLastSuccessAt,
    repository.snapshot != null,
  )
  const showingAcknowledgment = refreshAcknowledgment || recoveringWithFocus
  let label = ''
  if (unavailable) label = statusDetails.label ?? ''
  else if (showingAcknowledgment) label = 'Refresh complete'
  const details = statusDetails.details
  const showRetry = unavailable || showingAcknowledgment
  const visible = unavailable || showingAcknowledgment

  return (
    <section
      data-connection-state={state}
      aria-label="Connection status"
      className={
        visible ? 'mt-8 min-w-0 max-w-full shrink md:mt-0' : 'h-px w-px shrink-0 overflow-hidden'
      }
      onFocus={() => {
        statusHadFocus.current = true
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          statusHadFocus.current = false
          setRefreshAcknowledgment(false)
        }
      }}
    >
      <span aria-live="polite" data-connection-announcement className="sr-only">
        {announcement}
      </span>
      {visible ? (
        <div className="flex min-w-0 max-w-full items-start gap-2 text-xs">
          <details className="group min-w-0 flex-1">
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1 rounded-sm py-1 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <IconChevronSm
                aria-hidden="true"
                className="size-3 shrink-0 -rotate-90 transition-transform group-open:rotate-0"
              />
              <span className="min-w-0 overflow-wrap-anywhere">{label}</span>
            </summary>
            <div
              id={descriptionId}
              className="max-w-full overflow-wrap-anywhere pb-1 pl-4 leading-5 text-muted-foreground"
            >
              {details.map((detail, index) => (
                <span key={`${detail}-${index}`}>
                  {index > 0 && ' '}
                  {repository.connectionLastSuccessAt != null &&
                  detail.startsWith('Last refreshed') ? (
                    <time dateTime={new Date(repository.connectionLastSuccessAt).toISOString()}>
                      {detail}
                    </time>
                  ) : (
                    detail
                  )}
                </span>
              ))}
            </div>
          </details>
          {showRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              aria-describedby={unavailable ? descriptionId : undefined}
              onClick={retry}
            >
              <IconRefresh aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          )}
        </div>
      ) : (
        <span className="sr-only">Connected</span>
      )}
    </section>
  )
}
