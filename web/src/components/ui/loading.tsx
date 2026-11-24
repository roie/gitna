import { useEffect, useState, type ReactNode } from 'react'

export const LOADING_INDICATOR_DELAY_MS = 200

export function useLoadingIndicator(pending: boolean, operation?: unknown, startedAt?: number): boolean {
  const begin = () => {
    const start = startedAt ?? performance.now()
    return { pending, operation, start, visible: pending && performance.now() - start >= LOADING_INDICATOR_DELAY_MS }
  }
  const [state, setState] = useState(begin)
  if (state.pending !== pending || !Object.is(state.operation, operation)) setState(begin())

  useEffect(() => {
    if (!state.pending || state.visible) return
    const timer = window.setTimeout(() => {
      setState((current) => current === state ? { ...current, visible: true } : current)
    }, Math.max(0, LOADING_INDICATOR_DELAY_MS - (performance.now() - state.start)))
    return () => window.clearTimeout(timer)
  }, [state])

  return pending && state.pending && Object.is(state.operation, operation) && state.visible
}

export function LoadingIndicator({ pending = true, operation, children }: {
  pending?: boolean
  operation?: unknown
  children: ReactNode
}) {
  return useLoadingIndicator(pending, operation) ? children : null
}
