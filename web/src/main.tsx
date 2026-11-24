// Modified by Gitna: compose the standalone entry, native providers and local sessions.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ScrollbarGutterVariables } from './app/scrollbar-gutter'
import { Theme } from './lib/theme/theme-root'
import { WorkerPoolContext } from './app/worker-pool'
import { RepositoryProvider } from './repository/repository'
import { isHomePath } from './app/navigation'
import { startPreferenceSync } from './lib/preferences'

const pdfPath = new URLSearchParams(window.location.search).get('pdf')
type ReviewUI = typeof import('./app/workbench').Workbench
const StandalonePDF = lazy(() =>
  import('./features/viewer/preview/pdf-preview').then(({ PDFPreview }) => ({ default: PDFPreview })),
)
import './styles/fonts.css'
import '@pierre/words/styles.css'
import './styles/globals.css'

function App({ Workbench }: { Workbench: ReviewUI | null }) {
  const [searchRequest, setSearchRequest] = useState(0)
  const [folderURL, setFolderURL] = useState(
    window.history.state?.gitnaFolderURL ?? window.location.href,
  )
  const [homeOpen, setHomeOpen] = useState(isHomePath(window.location.pathname))
  const activeFolderURL = useRef(folderURL)
  const [focusFolderOnReady, setFocusFolderOnReady] = useState(false)
  const navigationGuard = useRef<(() => boolean) | null>(null)
  const historyIndex = useRef<number>(window.history.state?.gitnaFolderIndex ?? 0)
  const restoringHistory = useRef(false)
  const registerNavigationGuard = useCallback((guard: (() => boolean) | null) => {
    navigationGuard.current = guard
  }, [])
  const navigateFolder = useCallback((href: string) => {
    const target = new URL(href, window.location.href)
    target.hash = ''
    if (target.origin !== window.location.origin) throw new Error('Invalid folder origin')
    window.history.pushState(
      { gitnaFolderIndex: ++historyIndex.current, gitnaFolderURL: target.href },
      '',
      target.href,
    )
    activeFolderURL.current = target.href
    setHomeOpen(false)
    setFocusFolderOnReady(true)
    setSearchRequest(0)
    setFolderURL(target.href)
  }, [])

  const navigateHome = useCallback((open: boolean) => {
    const target = open
      ? new URL(
          isHomePath(new URL(activeFolderURL.current).pathname) ? './' : '../',
          activeFolderURL.current,
        ).href
      : activeFolderURL.current
    if (target === window.location.href) return
    window.history.pushState(
      {
        ...window.history.state,
        gitnaFolderIndex: ++historyIndex.current,
        gitnaFolderURL: activeFolderURL.current,
      },
      '',
      target,
    )
    setHomeOpen(open)
  }, [])

  useEffect(() => {
    window.history.replaceState(
      {
        ...window.history.state,
        gitnaFolderIndex: historyIndex.current,
        gitnaFolderURL: activeFolderURL.current,
      },
      '',
    )
    const onPopState = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        restoringHistory.current = false
        return
      }
      const nextIndex: unknown = event.state?.gitnaFolderIndex
      const isHome = isHomePath(window.location.pathname)
      const destination = new URL(event.state?.gitnaFolderURL ?? window.location.href)
      const current = new URL(activeFolderURL.current)
      if (destination.pathname === current.pathname && destination.search === current.search) {
        if (typeof nextIndex === 'number') historyIndex.current = nextIndex
        setHomeOpen(isHome)
        return
      }
      if (typeof nextIndex !== 'number') {
        window.location.reload()
        return
      }
      if (navigationGuard.current?.() === false) {
        restoringHistory.current = true
        window.history.go(historyIndex.current - nextIndex)
        return
      }
      historyIndex.current = nextIndex
      destination.hash = ''
      activeFolderURL.current = destination.href
      setHomeOpen(isHome)
      setFocusFolderOnReady(true)
      setSearchRequest(0)
      setFolderURL(destination.href)
    }
    const onHashChange = () => {
      if (typeof window.history.state?.gitnaFolderIndex === 'number') return
      window.history.replaceState(
        { ...window.history.state, gitnaFolderIndex: ++historyIndex.current },
        '',
      )
    }
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  useEffect(() => {
    const onSearchShortcut = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'f'
      ) {
        return
      }
      event.preventDefault()
      setSearchRequest((request) => request + 1)
    }
    window.addEventListener('keydown', onSearchShortcut)
    return () => window.removeEventListener('keydown', onSearchShortcut)
  }, [])
  if (pdfPath != null) {
    return (
      <Theme>
        <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Media preview">
          <Suspense fallback={null}>
            <StandalonePDF path={pdfPath} standalone />
          </Suspense>
        </section>
      </Theme>
    )
  }
  if (Workbench == null) throw new Error('Missing Gitna workbench')
  return (
    <>
      <ScrollbarGutterVariables />
      <WorkerPoolContext>
        <Theme>
          <RepositoryProvider key={folderURL} baseURL={folderURL}>
            <Workbench
              homeOpen={homeOpen}
              onHomeNavigate={navigateHome}
              folderURL={folderURL}
              searchRequest={searchRequest}
              focusOnReady={focusFolderOnReady}
              onFolderNavigate={navigateFolder}
              onNavigationGuardChange={registerNavigationGuard}
            />
          </RepositoryProvider>
          <div id="dark-mode-portal-container" className="dark" data-theme="dark" />
          <div id="light-mode-portal-container" className="light" data-theme="light" />
        </Theme>
      </WorkerPoolContext>
    </>
  )
}

const root = document.getElementById('root')
if (root == null) throw new Error('Missing Gitna React root')
root.className = 'flex h-dvh min-h-0 flex-col'
startPreferenceSync()
async function mountApp(root: HTMLElement): Promise<void> {
  const Workbench = pdfPath == null ? (await import('./app/workbench')).Workbench : null
  createRoot(root).render(<App Workbench={Workbench} />)
}

void mountApp(root).catch((error: unknown) => {
  console.error('Could not load Gitna', error)
  const loading = document.querySelector('[data-startup-loading]')
  loading?.setAttribute('aria-busy', 'false')
  const status = document.getElementById('startup-status')
  if (status != null) {
    status.setAttribute('role', 'alert')
    status.textContent = 'Could not load Gitna. Reload to try again.'
  }
  document.querySelector('.startup-spinner')?.remove()
  document.getElementById('startup-retry')?.removeAttribute('hidden')
})
