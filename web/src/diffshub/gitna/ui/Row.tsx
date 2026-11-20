import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/cn'

interface RowProps extends Omit<ComponentProps<'button'>, 'children'> {
  actions?: ReactNode
  detail?: ReactNode
  icon?: ReactNode
  label: ReactNode
  selected?: boolean
  size?: 'sm' | 'lg'
  status?: ReactNode
}

export function Row({
  actions,
  className,
  detail,
  icon,
  label,
  selected = false,
  size = 'sm',
  status,
  ...props
}: RowProps) {
  const large = size === 'lg'
  return (
    <div
      className={cn(
        'group/row flex min-w-0 items-center gap-1 rounded-md px-2 hover:bg-accent',
        large ? 'min-h-10 text-sm' : 'h-7 text-xs',
        selected && 'bg-accent text-accent-foreground',
        className,
      )}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        {...props}
      >
        {icon}
        {large ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            {detail != null && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">{label}</span>
            {detail != null && (
              <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
            )}
          </>
        )}
        {status ? <span className="ms-auto flex shrink-0 items-center">{status}</span> : null}
      </button>
      {actions}
    </div>
  )
}
