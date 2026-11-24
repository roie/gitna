import { type ReactNode, useRef, useState } from 'react'

import { IconX } from '@pierre/icons'

import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

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
  const ownerSelector =
    'dialog, [role="dialog"], [role="alertdialog"], [data-pane], [role="region"][aria-label="Review"]'
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
  const [restoreFocus] = useState(captureReturnFocus)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        {...(role == null ? {} : { role })}
        aria-describedby={undefined}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          const input = (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>(
            'input[data-autofocus]',
          )
          if (input == null) return
          event.preventDefault()
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus()
        }}
        className="flex max-h-[min(720px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      >
        <div className="flex items-center border-b border-border px-4 py-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{title}</DialogTitle>
          <Button variant="ghost" size="icon-only" aria-label="Close dialog" onClick={onClose}>
            <IconX className="size-4" />
          </Button>
        </div>
        <div className="list-scrollbar min-h-0 overflow-y-auto overscroll-contain p-4">
          {disabledReason != null && (
            <p className="mb-3 overflow-wrap-anywhere text-xs text-muted-foreground" role="note">
              {disabledReason}
            </p>
          )}
          {error != null && (
            <p className="mb-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          {children}
        </div>
      </DialogContent>
    </Dialog>
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
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent
        role="alertdialog"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
          {disabledReason != null && (
            <p
              id="gitna-confirm-disabled-reason"
              className="overflow-wrap-anywhere text-xs text-muted-foreground"
              role="note"
            >
              {disabledReason}
            </p>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={disabledReason != null}
            aria-describedby={disabledReason == null ? undefined : 'gitna-confirm-disabled-reason'}
            onClick={async () => {
              await onConfirm()
              requestAnimationFrame(() => {
                if (document.activeElement === document.body) restoreFocus()
              })
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
