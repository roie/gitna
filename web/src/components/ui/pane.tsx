import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

interface PaneProps extends ComponentProps<'div'> {
  variant?: 'list' | 'code'
}

export function Pane({ variant = 'list', className, ...props }: PaneProps) {
  return (
    <div
      className={cn(
        'overflow-y-auto overscroll-contain',
        variant === 'list' ? 'list-scrollbar' : 'cv-scrollbar',
        className,
      )}
      {...props}
    />
  )
}
