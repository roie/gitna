import { IconChevronSm } from '@pierre/icons'
import type { ComponentType, ReactNode, Ref } from 'react'

import { cn } from '../../lib/cn'
import { Count } from './Count'

interface HeaderProps {
  accessory?: ReactNode
  actions?: ReactNode
  className?: string
  count?: ReactNode
  countTitle?: string
  dataSection?: string
  icon: ComponentType<{ className?: string }>
  level: 'pane' | 'section'
  onOpenChange?: (open: boolean) => void
  open?: boolean
  ref?: Ref<HTMLButtonElement>
  title: string
}

const focus =
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring'

export function Header({
  accessory,
  actions,
  className,
  count,
  countTitle,
  dataSection,
  icon: Icon,
  level,
  onOpenChange,
  open,
  ref,
  title,
}: HeaderProps) {
  const pane = level === 'pane'
  const Title = onOpenChange == null ? 'h2' : 'span'
  const label = (
    <>
      {!pane && onOpenChange != null && (
        <IconChevronSm
          className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')}
        />
      )}
      <Icon className={cn('size-3 shrink-0', pane && 'opacity-50')} />
      <Title
        className={cn('section-title min-w-0 flex-1 truncate', !pane && 'font-medium')}
        title={title}
      >
        {title}
      </Title>
      {pane && count != null && <Count title={countTitle}>{count}</Count>}
    </>
  )
  const titleClass = cn(
    'section-header flex min-w-0 flex-1 items-center text-left',
    pane ? 'min-w-[min(100%,6rem)] gap-2' : 'h-8 gap-1.5 px-3',
  )
  const titleElement =
    onOpenChange == null ? (
      <div className={titleClass} data-section={dataSection}>
        {label}
      </div>
    ) : (
      <button
        ref={ref}
        type="button"
        className={cn(titleClass, 'cursor-pointer', pane && 'hover:text-foreground', focus)}
        data-section={dataSection}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {label}
      </button>
    )

  if (pane) {
    return (
      <div
        className={cn(
          'border-border text-muted-foreground flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2 text-sm md:mx-3 md:px-2',
          className,
        )}
      >
        {titleElement}
        {accessory}
        {actions != null && (
          <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-1">
            {actions}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group/header flex h-8 shrink-0 items-center text-xs hover:bg-accent focus-within:bg-accent',
        className,
      )}
    >
      {titleElement}
      {accessory}
      {actions != null && (
        <div className="flex shrink-0 items-center opacity-0 group-focus-within/header:opacity-100 group-hover/header:opacity-100 max-md:opacity-100">
          {actions}
        </div>
      )}
      {count != null && (
        <Count className="min-w-7 pr-3 text-right" title={countTitle}>
          {count}
        </Count>
      )}
    </div>
  )
}
