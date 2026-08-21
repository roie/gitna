'use client'

// Modified from the pinned DiffsHub donor: Gitna's only sidebar is the
// VS Code Source Control workflow. The donor tab row, comments, diff stats and
// worker monitor are removed; the themed responsive drawer remains intact.
import {
  type CSSProperties,
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useState,
} from 'react'

import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles'
import { useChromeThemeProps } from './useChromeThemeProps'
import { Button } from '@/components/Button'
import { cn } from '@/lib/cn'
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping'
import { IconXSquircle } from '@pierre/icons'

const MOBILE_MEDIA_QUERY = '(max-width: 767px)'

interface DiffsHubSidebarProps {
  children: ReactNode
  className?: string
  mobileOverlayOpen?: boolean
  onMobileClose(): void
  scrollRef: RefObject<HTMLDivElement | null>
}

export const DiffsHubSidebar = memo(function DiffsHubSidebar({
  children,
  className,
  mobileOverlayOpen = false,
  onMobileClose,
  scrollRef,
}: DiffsHubSidebarProps) {
  const [mobileViewport, setMobileViewport] = useState(
    () => window.matchMedia(MOBILE_MEDIA_QUERY).matches,
  )
  const { style: sidebarChromeStyle } = useChromeThemeProps(diffshubChromeMapping)
  const sidebarStyle = Object.keys(sidebarChromeStyle).length > 0 ? sidebarChromeStyle : undefined

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const update = (event: MediaQueryListEvent) => setMobileViewport(event.matches)
    setMobileViewport(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!mobileOverlayOpen || !window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      return undefined
    }

    const { body, documentElement } = document
    const codeViewScroll = scrollRef.current
    const previousBodyOverflow = body.style.overflow
    const previousRootOverscrollBehavior = documentElement.style.overscrollBehavior
    const previousCodeViewOverflow = codeViewScroll?.style.overflow

    body.style.overflow = 'hidden'
    documentElement.style.overscrollBehavior = 'none'
    if (codeViewScroll != null) codeViewScroll.style.overflow = 'hidden'

    return () => {
      body.style.overflow = previousBodyOverflow
      documentElement.style.overscrollBehavior = previousRootOverscrollBehavior
      if (codeViewScroll != null) codeViewScroll.style.overflow = previousCodeViewOverflow ?? ''
    }
  }, [mobileOverlayOpen, scrollRef])

  return (
    <>
      <button
        type="button"
        aria-hidden={!mobileOverlayOpen}
        aria-label="Close Source Control"
        tabIndex={mobileOverlayOpen ? 0 : -1}
        className={cn(
          'z-20 cursor-default bg-background/60 backdrop-blur-xs transition-opacity [grid-column:1/-1] [grid-row:1/-1] md:hidden',
          mobileOverlayOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onMobileClose}
      />
      <SidebarWrapper
        className={className}
        mobileHidden={mobileViewport && !mobileOverlayOpen}
        mobileOverlayOpen={mobileOverlayOpen}
        themeStyle={sidebarStyle}
      >
        <div className="flex h-10 shrink-0 items-center justify-end px-4 md:hidden">
          <Button
            variant="ghost"
            size="icon-only"
            className={CHROME_ICON_BUTTON_CLASS}
            aria-label="Close Source Control"
            onClick={onMobileClose}
          >
            <IconXSquircle className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </SidebarWrapper>
    </>
  )
})

interface SidebarWrapperProps {
  children: ReactNode
  className?: string
  mobileHidden: boolean
  mobileOverlayOpen: boolean
  themeStyle?: CSSProperties
}

function SidebarWrapper({
  children,
  className,
  mobileHidden,
  mobileOverlayOpen,
  themeStyle,
}: SidebarWrapperProps) {
  return (
    <aside
      aria-hidden={mobileHidden || undefined}
      aria-label="Source Control"
      inert={mobileHidden || undefined}
      className={cn(
        className,
        'contain-strict z-30 flex h-full min-h-0 flex-col border-r border-[var(--color-border-opaque)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none md:z-auto md:translate-y-0 md:will-change-auto',
        themeStyle == null && 'bg-[var(--diffshub-sidebar-bg)]',
        mobileOverlayOpen
          ? 'pointer-events-auto translate-y-0 overflow-hidden rounded-t-xl shadow-[0_16px_32px_rgb(0_0_0_/0.25)] md:h-full md:overflow-visible md:rounded-none md:shadow-none'
          : 'pointer-events-none translate-y-[calc(100%+1.5rem)] overflow-hidden rounded-xl md:pointer-events-auto md:h-full md:overflow-visible md:rounded-none',
      )}
      style={themeStyle}
    >
      {children}
    </aside>
  )
}
