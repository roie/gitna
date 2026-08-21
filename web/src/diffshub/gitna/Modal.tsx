import { type ReactNode, useEffect, useRef } from 'react'

import { IconX } from '@pierre/icons'

import { Button } from '../components/Button'
import { cn } from '../lib/cn'

interface ModalProps {
  children: ReactNode
  destructive?: boolean
  onClose(): void
  role?: 'dialog' | 'alertdialog'
  title: string
}

export function Modal({
  children,
  destructive = false,
  onClose,
  role = 'dialog',
  title,
}: ModalProps) {
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
      role={role}
      className={cn(
        'm-auto max-h-[min(720px,calc(100dvh-2rem))] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/45',
        destructive && 'border-red-500/40',
      )}
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
      <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto p-4">{children}</div>
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
  return (
    <Modal destructive onClose={onCancel} role="alertdialog" title={title}>
      <p className="text-sm leading-6 text-muted-foreground">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="bg-red-600 text-white hover:bg-red-700"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}
