import { type ReactNode, useEffect, useRef } from 'react'

import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { IconX } from '@pierre/icons'

import { Button } from '../components/Button'

interface ModalProps {
  children: ReactNode
  onClose(): void
  title: string
}

export function Modal({ children, onClose, title }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    dialog.showModal()
    const onCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [onClose])

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      className="m-auto max-h-[min(720px,calc(100dvh-2rem))] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-lg backdrop:bg-black/45"
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
        {children}
      </div>
    </dialog>
  )
}

interface ConfirmProps {
  confirmLabel: string
  message: string
  onCancel(): void
  onConfirm(): void
  title: string
}

export function Confirm({ confirmLabel, message, onCancel, onConfirm, title }: ConfirmProps) {
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
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 text-foreground shadow-lg outline-none">
          <AlertDialog.Title className="text-base font-semibold leading-none">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm leading-6 text-muted-foreground">
            {message}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="destructive" size="sm" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
