import { type ReactNode, useEffect, useRef, useState } from 'react'

import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { IconX } from '@pierre/icons'

import { Button } from '../components/Button'

function captureReturnFocus(): () => void {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  const menu = active?.closest('[role="menu"]')
  const root = active?.getRootNode() as Document | ShadowRoot | undefined
  const triggerId = menu?.getAttribute('aria-labelledby')
  const target = (
    triggerId == null ? active : root?.getElementById(triggerId)
  ) as HTMLElement | null
  const label = target?.getAttribute('aria-label')
  const ownerSelector = 'dialog, [data-pane], [role="region"][aria-label="Review"]'
  const owner =
    target?.closest(ownerSelector) ??
    (root instanceof ShadowRoot ? root.host.closest(ownerSelector) : null)
  return () => {
    if (target?.isConnected && !target.matches(':disabled')) {
      target.focus()
      return
    }
    const replacement = Array.from(
      owner?.querySelectorAll<HTMLElement>('button[aria-label]') ?? [],
    ).find(
      (element) => element.getAttribute('aria-label') === label && !element.matches(':disabled'),
    )
    const fallback = owner?.isConnected
      ? owner.querySelector<HTMLElement>(
          'button[aria-label="Close dialog"]:not(:disabled), button[data-menu-focus-fallback]:not(:disabled)',
        )
      : null
    const destination = replacement ?? fallback
    if (!destination?.isConnected || destination.matches(':disabled')) return
    destination?.focus()
  }
}

interface ModalProps {
  children: ReactNode
  error?: string | null
  onClose: () => void
  disabledReason?: string | null
  role?: 'dialog' | 'alertdialog'
  title: string
}

export function Modal({ children, onClose, disabledReason, error, role, title }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [restoreFocus] = useState(captureReturnFocus)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    dialog.showModal()
    const onCancel = (event: Event) => {
      event.preventDefault()
      closeRef.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.close()
      restoreFocus()
    }
  }, [restoreFocus])

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      role={role}
      className="m-auto max-h-[min(720px,calc(100dvh-2rem))] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground backdrop:bg-black/45"
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="flex items-center border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-only" aria-label="Close dialog" onClick={onClose}>
          <IconX className="size-4" />
        </Button>
      </div>
      <div className="gitna-scrollbar max-h-[calc(100dvh-8rem)] overflow-y-auto overscroll-contain p-4">
        {disabledReason != null && (
          <p className="mb-3 overflow-wrap-anywhere text-xs text-muted-foreground" role="note">
            {disabledReason}
          </p>
        )}
        {error != null && (
          <p className="mb-3 text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {children}
      </div>
    </dialog>
  )
}

interface ConfirmProps {
  confirmLabel: string
  message: string
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  disabledReason?: string | null
  title: string
}

export function Confirm({
  confirmLabel,
  message,
  onCancel,
  onConfirm,
  disabledReason,
  title,
}: ConfirmProps) {
  const [restoreFocus] = useState(captureReturnFocus)
  const portalContainer =
    typeof document === 'undefined'
      ? undefined
      : (document.querySelector('dialog[open]') ?? undefined)
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialog.Portal container={portalContainer}>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus()
          }}
          className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 text-foreground shadow-lg outline-none"
        >
          <AlertDialog.Title className="text-base font-semibold leading-none">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm leading-6 text-muted-foreground">
            {message}
          </AlertDialog.Description>
          {disabledReason != null && (
            <p
              id="gitna-confirm-disabled-reason"
              className="mt-3 overflow-wrap-anywhere text-xs text-muted-foreground"
              role="note"
            >
              {disabledReason}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={disabledReason != null}
                aria-describedby={
                  disabledReason == null ? undefined : 'gitna-confirm-disabled-reason'
                }
                onClick={async () => {
                  await onConfirm()
                  requestAnimationFrame(() => {
                    if (document.activeElement === document.body) restoreFocus()
                  })
                }}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
