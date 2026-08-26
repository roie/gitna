import { useCallback, useEffect, useRef, useState } from 'react'

import { IconX } from '@pierre/icons'

import { Button } from '../components/Button'
import { cn } from '../lib/cn'
import type { ImageAnnotationMetadata } from '../lib/types'

function ImageLightbox({ alt, onClose, src }: { alt: string; onClose(): void; src: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    dialog.showModal()
    const handleCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', handleCancel)
    return () => dialog.removeEventListener('cancel', handleCancel)
  }, [onClose])

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Image viewer: ${alt}`}
      className="m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden border-0 bg-black/85 p-0 backdrop:bg-transparent"
      onClick={onClose}
    >
      <div className="relative flex h-full w-full items-center justify-center p-6">
        <Button
          variant="ghost"
          size="icon-only"
          className="absolute right-3 top-3 z-10 text-white hover:bg-white/10 hover:text-white"
          aria-label="Close image viewer"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <IconX className="size-5" />
        </Button>
        <img
          src={src}
          alt={alt}
          className="block max-h-full max-w-full object-contain shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </dialog>
  )
}

export function ImageAnnotation({
  fill = false,
  metadata,
}: {
  fill?: boolean
  metadata: ImageAnnotationMetadata
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const src = `data:${metadata.image.mime};base64,${metadata.image.data}`

  return (
    <>
      <div
        className={cn(
          'flex min-w-0 items-center justify-center overflow-auto',
          fill && 'h-[calc(100dvh-6rem)] p-6',
        )}
      >
        <button
          type="button"
          className="flex max-h-full max-w-full cursor-zoom-in items-center justify-center bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={`Open ${metadata.alt} in image viewer`}
          onClick={() => setOpen(true)}
        >
          <img
            src={src}
            alt={metadata.alt}
            className="block max-h-[calc(100dvh-8rem)] max-w-full object-contain"
          />
        </button>
      </div>
      {open && <ImageLightbox alt={metadata.alt} src={src} onClose={close} />}
    </>
  )
}
