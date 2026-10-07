import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ScrollbarGutterVariables } from './components/ScrollbarGutterVariables'
import { ThemeProvider } from './components/ThemeProvider'
import { WorkerPoolContext } from './components/WorkerPoolContext'
import { RepositoryProvider } from './gitna/repository'

const pdfPath = new URLSearchParams(window.location.search).get('pdf')
type ReviewUI = typeof import('./gitna/GitnaReviewUI').GitnaReviewUI
const StandalonePDF = lazy(() =>
  import('./gitna/PDFPreview').then(({ PDFPreview }) => ({ default: PDFPreview })),
)
import './vite/fonts.css'
import './globals.css'

function App({ GitnaReviewUI }: { GitnaReviewUI: ReviewUI | null }) {
  const [searchRequest, setSearchRequest] = useState(0)
  const [folderURL, setFolderURL] = useState(window.location.href)
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
      { ...window.history.state, gitnaFolderIndex: ++historyIndex.current },
      '',
      target.href,
    )
    activeFolderURL.current = target.href
    setFocusFolderOnReady(true)
    setSearchRequest(0)
    setFolderURL(target.href)
  }, [])

  useEffect(() => {
    window.history.replaceState(
      { ...window.history.state, gitnaFolderIndex: historyIndex.current },
      '',
    )
    const onPopState = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        restoringHistory.current = false
        return
      }
      const nextIndex: unknown = event.state?.gitnaFolderIndex
      const destination = new URL(window.location.href)
      const current = new URL(activeFolderURL.current)
      if (destination.pathname === current.pathname && destination.search === current.search) {
        if (typeof nextIndex === 'number') historyIndex.current = nextIndex
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
      <ThemeProvider attribute="class">
        <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Media preview">
          <Suspense fallback={null}>
            <StandalonePDF path={pdfPath} standalone />
          </Suspense>
        </section>
      </ThemeProvider>
    )
  }
  if (GitnaReviewUI == null) throw new Error('Missing Gitna workbench')
  return (
    <>
      <ScrollbarGutterVariables />
      <WorkerPoolContext>
        <ThemeProvider attribute="class">
          <RepositoryProvider key={folderURL} baseURL={folderURL}>
            <GitnaReviewUI
              searchRequest={searchRequest}
              focusOnReady={focusFolderOnReady}
              onFolderNavigate={navigateFolder}
              onNavigationGuardChange={registerNavigationGuard}
            />
          </RepositoryProvider>
          <div id="dark-mode-portal-container" className="dark" data-theme="dark" />
          <div id="light-mode-portal-container" className="light" data-theme="light" />
        </ThemeProvider>
      </WorkerPoolContext>
    </>
  )
}

const root = document.getElementById('diffshub-root')
if (root == null) throw new Error('Missing DiffsHub React root')
root.className = 'flex h-dvh min-h-0 flex-col'
async function mountApp(root: HTMLElement): Promise<void> {
  const GitnaReviewUI =
    pdfPath == null ? (await import('./gitna/GitnaReviewUI')).GitnaReviewUI : null
  createRoot(root).render(<App GitnaReviewUI={GitnaReviewUI} />)
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
