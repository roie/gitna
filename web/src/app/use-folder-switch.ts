import type { ColorMode } from '@pierre/theming'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { LOADING_INDICATOR_DELAY_MS } from '../components/ui/loading'
import {
  ActionGuardError,
  startupTraceEnabled,
  type GitnaRepository,
} from '../repository/repository'
import { folderDisplayName } from './loading-screen'
import { resolveFolderHref } from './navigation'

const switchStartupStorageKey = 'gitna:switch-start'

export function markDestinationStartup(): void {
  if (!startupTraceEnabled()) return
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  if (navigation != null) {
    performance.mark('gitna:destination-response', { startTime: navigation.responseStart })
  }
  performance.mark('gitna:mount')
  let raw: string | null
  try {
    raw = sessionStorage.getItem(switchStartupStorageKey)
    sessionStorage.removeItem(switchStartupStorageKey)
  } catch {
    return
  }
  if (raw == null) return
  try {
    const marker = JSON.parse(raw) as { startedAt?: unknown; version?: unknown }
    if (
      marker.version === 1 &&
      typeof marker.startedAt === 'number' &&
      Date.now() - marker.startedAt >= 0 &&
      Date.now() - marker.startedAt < 5 * 60_000
    ) {
      performance.mark('gitna:switch-destination', {
        detail: { elapsedMs: Date.now() - marker.startedAt },
      })
    }
  } catch {
    // A malformed local marker is ignored and removed above.
  }
}

function gitnaLogoDataUrl(dark: boolean): string | null {
  const filename = dark ? 'gitna-logo-dark.png' : 'gitna-logo-light.png'
  const source = [...window.document.images].find((image) => image.src.endsWith(`/${filename}`))
  if (source == null || !source.complete || source.naturalWidth === 0) return null
  const canvas = window.document.createElement('canvas')
  canvas.width = source.naturalWidth
  canvas.height = source.naturalHeight
  canvas.getContext('2d')?.drawImage(source, 0, 0)
  return canvas.toDataURL('image/png')
}

function renderFolderLoadingDocument(newTab: Window, path: string, colorMode: ColorMode): void {
  const document = newTab.document
  const folderName = folderDisplayName(path)
  const assetUrl = (name: string) => new URL(`./${name}`, window.location.href).href
  const dark =
    colorMode === 'dark' ||
    (colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const logoUrl =
    gitnaLogoDataUrl(dark) ?? assetUrl(dark ? 'gitna-logo-dark.png' : 'gitna-logo-light.png')

  document.documentElement.lang = 'en'
  document.documentElement.dataset.colorMode = colorMode

  const title = document.createElement('title')
  title.textContent = `Opening ${folderName} - Gitna`
  const viewport = document.createElement('meta')
  viewport.name = 'viewport'
  viewport.content = 'width=device-width, initial-scale=1'
  const favicon = document.createElement('link')
  favicon.rel = 'icon'
  favicon.type = 'image/png'
  favicon.href = assetUrl(dark ? 'favicon-dark.png' : 'favicon-light.png')
  const root = getComputedStyle(window.document.documentElement)
  const token = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback
  const style = document.createElement('style')
  style.textContent = `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; --bg: ${token('--background', 'Canvas')}; --fg: ${token('--foreground', 'CanvasText')}; --muted: ${token('--muted-foreground', 'GrayText')}; --ring: ${token('--border', 'GrayText')}; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @keyframes show-loading { from { visibility: hidden; } to { visibility: visible; } }
    main { animation: show-loading 0s ${LOADING_INDICATOR_DELAY_MS}ms both; display: flex; max-width: calc(100vw - 3rem); flex-direction: column; align-items: center; text-align: center; }
    .brand { display: flex; align-items: center; gap: .625rem; font-size: 1rem; font-weight: 600; }
    .brand img { width: 40px; height: 40px; }
    h1 { max-width: 28rem; margin: 1.25rem 0 0; overflow: hidden; text-overflow: ellipsis; font-size: 1.125rem; font-weight: 600; white-space: nowrap; }
    p { margin: .375rem 0 0; color: var(--muted); font-size: .875rem; }
    .spinner { width: 18px; height: 18px; margin-top: 1.25rem; border: 2px solid var(--ring); border-top-color: var(--fg); border-radius: 999px; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  `
  document.head.replaceChildren(title, viewport, favicon, style)

  const main = document.createElement('main')
  const brand = document.createElement('div')
  brand.className = 'brand'
  const logo = document.createElement('img')
  logo.src = logoUrl
  logo.alt = ''
  const brandName = document.createElement('span')
  brandName.textContent = 'Gitna'
  brand.replaceChildren(logo, brandName)
  const heading = document.createElement('h1')
  heading.textContent = `Opening ${folderName}`
  const status = document.createElement('p')
  status.role = 'status'
  status.textContent = 'Preparing your folder…'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  spinner.setAttribute('aria-hidden', 'true')
  main.replaceChildren(brand, heading, status, spinner)
  document.body.replaceChildren(main)
}

export interface FolderSwitchOperation {
  controller: AbortController
  id: number
  previousFocus: HTMLElement | null
  previousTitle: string
}

export function useFolderSwitch({
  allowFolderNavigationRef,
  operationRef: folderSwitchOperationRef,
  closeHome,
  colorMode,
  dirty,
  folderURL,
  onFolderNavigate,
  repository,
  setHomeOpen,
  setHomeSwitchError,
  setReviewActionError,
}: {
  allowFolderNavigationRef: RefObject<boolean>
  operationRef: RefObject<FolderSwitchOperation | null>
  closeHome: () => void
  colorMode: ColorMode
  dirty: boolean
  folderURL: string
  onFolderNavigate?: (href: string) => void
  repository: GitnaRepository
  setHomeOpen: (open: boolean) => void
  setHomeSwitchError: (error: string | null) => void
  setReviewActionError: (error: string | null) => void
}) {
  const [pendingFolderSwitch, setPendingFolderSwitch] = useState<{
    focusTarget: HTMLElement | null
    path: string
    returnHome: boolean
  } | null>(null)
  const [folderSwitchTransition, setFolderSwitchTransition] = useState<{
    id: number
    path: string
  } | null>(null)
  const nextFolderSwitchIDRef = useRef(0)
  const folderSwitchRestoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (folderSwitchTransition != null) {
      folderSwitchRestoreFocusRef.current = null
      return
    }
    const target = folderSwitchRestoreFocusRef.current
    if (target == null) return
    // Restore only after React has removed inertness from the old workbench.
    const frame = requestAnimationFrame(() => {
      folderSwitchRestoreFocusRef.current = null
      target.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [folderSwitchTransition])
  const performFolderSwitch = useCallback(
    async (path: string, returnHome: boolean, restoreFocus?: HTMLElement | null) => {
      const reason = repository.getActionDisabledReason('open-folder')
      if (reason != null) {
        if (returnHome) setHomeSwitchError(reason)
        else setReviewActionError(reason)
        return
      }
      if (returnHome) setHomeSwitchError(null)
      const previousOperation = folderSwitchOperationRef.current
      previousOperation?.controller.abort()
      const id = ++nextFolderSwitchIDRef.current
      const controller = new AbortController()
      const previousTitle = previousOperation?.previousTitle ?? document.title
      const previousFocus =
        restoreFocus ??
        previousOperation?.previousFocus ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      folderSwitchOperationRef.current = { controller, id, previousFocus, previousTitle }
      setFolderSwitchTransition({ id, path })
      document.title = `Opening ${folderDisplayName(path)} - Gitna`
      const traceStartup = startupTraceEnabled()
      if (traceStartup) {
        try {
          sessionStorage.setItem(
            switchStartupStorageKey,
            JSON.stringify({ version: 1, startedAt: Date.now() }),
          )
        } catch {
          // Startup diagnostics are optional and never block navigation.
        }
      }

      // Let React commit the transition before starting potentially expensive
      // local discovery. This gives immediate, truthful feedback even on a
      // cold or deeply nested folder.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (folderSwitchOperationRef.current?.id !== id) return
      try {
        const result = await repository.openFolder(path, controller.signal)
        if (folderSwitchOperationRef.current?.id !== id) return
        const target = resolveFolderHref(result.href, folderURL)
        if (target.origin !== window.location.origin) {
          throw new Error('folder route must remain on the current Gitna origin')
        }
        if (traceStartup) target.searchParams.set('trace-startup', '1')
        if (
          onFolderNavigate != null &&
          target.pathname === window.location.pathname &&
          target.search === window.location.search
        ) {
          folderSwitchOperationRef.current = null
          folderSwitchRestoreFocusRef.current = previousFocus
          setFolderSwitchTransition(null)
          setHomeOpen(false)
          document.title = previousTitle
          try {
            sessionStorage.removeItem(switchStartupStorageKey)
          } catch {
            // Startup diagnostics are optional and never block recovery.
          }
          return
        }
        allowFolderNavigationRef.current = true
        if (onFolderNavigate == null) window.location.assign(target.href)
        else onFolderNavigate(target.href)
      } catch (error) {
        if (folderSwitchOperationRef.current?.id !== id) return
        allowFolderNavigationRef.current = false
        folderSwitchOperationRef.current = null
        folderSwitchRestoreFocusRef.current = previousFocus
        setFolderSwitchTransition(null)
        if (traceStartup) {
          try {
            sessionStorage.removeItem(switchStartupStorageKey)
          } catch {
            // Startup diagnostics are optional and never block recovery.
          }
        }
        document.title = previousTitle
        const detail = error instanceof Error ? error.message : String(error)
        const message = `Could not open ${folderDisplayName(path)}: ${detail}`
        if (!returnHome) {
          setReviewActionError(message)
          throw new Error(message, { cause: error })
        }
        setHomeSwitchError(message)
      }
    },
    [
      allowFolderNavigationRef,
      folderSwitchOperationRef,
      folderURL,
      repository,
      onFolderNavigate,
      setHomeOpen,
      setHomeSwitchError,
      setReviewActionError,
    ],
  )
  const openFolderInNewTab = useCallback(
    (path: string): Promise<void> => {
      const reason = repository.getActionDisabledReason('open-folder')
      if (reason != null) return Promise.reject(new ActionGuardError(reason))
      const newTab = window.open()
      if (newTab == null) {
        return Promise.reject(new Error('Allow pop-ups to open this folder in a new tab.'))
      }
      renderFolderLoadingDocument(newTab, path, colorMode)
      return repository
        .openFolder(path)
        .then((result) => {
          const target = resolveFolderHref(result.href, folderURL)
          if (target.origin !== window.location.origin) {
            throw new Error('folder route must remain on the current Gitna origin')
          }
          if (!newTab.closed) newTab.location.replace(target.href)
        })
        .catch((error: unknown) => {
          if (!newTab.closed) newTab.close()
          throw error
        })
    },
    [colorMode, folderURL, repository],
  )
  const requestFolderSwitch = useCallback(
    async (path: string, returnHome: boolean) => {
      const reason = repository.getActionDisabledReason('open-folder')
      if (reason != null) {
        if (returnHome) setHomeSwitchError(reason)
        else setReviewActionError(reason)
        return
      }
      if (path === repository.snapshot?.root) {
        if (returnHome) closeHome()
        return
      }
      if (dirty) {
        setPendingFolderSwitch({
          focusTarget:
            document.activeElement instanceof HTMLElement ? document.activeElement : null,
          path,
          returnHome,
        })
        return
      }
      await performFolderSwitch(path, returnHome)
    },
    [closeHome, dirty, performFolderSwitch, repository, setHomeSwitchError, setReviewActionError],
  )

  return {
    folderSwitchTransition,
    openFolderInNewTab,
    pendingFolderSwitch,
    performFolderSwitch,
    requestFolderSwitch,
    setPendingFolderSwitch,
  }
}
