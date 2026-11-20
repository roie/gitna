import { useCallback, useState } from 'react'

import { IconX } from '@pierre/icons'

import { Button } from '../components/Button'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { cn } from '../lib/cn'
import type { ImageAnnotationMetadata } from '../lib/types'

function Lightbox({ alt, onClose, src }: { alt: string; onClose: () => void; src: string }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-dvw max-w-none translate-0 items-center justify-center rounded-none border-0 bg-black/70 p-6 sm:max-w-none"
        onClick={onClose}
      >
        <DialogTitle className="sr-only">{`Image viewer: ${alt}`}</DialogTitle>
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
          className="block max-h-full max-w-full object-contain"
          onClick={(event) => event.stopPropagation()}
        />
      </DialogContent>
    </Dialog>
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
          'list-scrollbar flex min-w-0 items-center justify-center overflow-auto',
          fill && 'h-[calc(100dvh-6rem)] p-6',
        )}
      >
        <button
          type="button"
          className="flex max-h-full max-w-full cursor-zoom-in items-center justify-center bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
      {open && <Lightbox alt={metadata.alt} src={src} onClose={close} />}
    </>
  )
}
