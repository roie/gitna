import { lazy, Suspense, useEffect, useState } from 'react'
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
          <RepositoryProvider>
            <GitnaReviewUI searchRequest={searchRequest} />
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

void mountApp(root)
