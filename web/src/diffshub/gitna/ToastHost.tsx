import { IconX } from '@pierre/icons'
import type { ReactNode } from 'react'

import { Button } from '../components/Button'

export interface Toast {
  action?: { disabled?: boolean; label: string; onClick(): void }
  dataState?: string
  description?: ReactNode
  id: string
  onDismiss(): void
  severity: 'error' | 'info' | 'warning'
  title: string
}

const severityClass = {
  error: 'border-red-400/50 bg-red-600 text-white',
  info: 'border-border bg-background text-foreground',
  warning: 'border-border bg-background text-foreground',
} as const

export function ToastHost({ toasts }: { toasts: readonly Toast[] }) {
  if (toasts.length === 0) return null
  return (
    <div
      aria-label="Notifications"
      className="fixed right-3 bottom-3 z-50 flex w-[min(28rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${severityClass[toast.severity]}`}
          data-connection-state={toast.dataState}
          role={toast.severity === 'error' ? 'alert' : 'status'}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{toast.title}</p>
            {toast.description != null && (
              <div className="mt-1 leading-5 opacity-85">{toast.description}</div>
            )}
          </div>
          {toast.action != null && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              disabled={toast.action.disabled}
              onClick={toast.action.onClick}
            >
              {toast.action.label}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-only"
            className="size-6 shrink-0"
            aria-label={`Dismiss ${toast.title}`}
            onClick={toast.onDismiss}
          >
            <IconX aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  )
}
