import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Count({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('section-count shrink-0 text-xs tabular-nums text-muted-foreground', className)}
      {...props}
    />
  )
}
