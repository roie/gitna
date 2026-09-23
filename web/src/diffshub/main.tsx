import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

import { PreloadHighlighter } from './components/PreloadHighlighter'
import { ScrollbarGutterVariables } from './components/ScrollbarGutterVariables'
import { ThemeProvider } from './components/ThemeProvider'
import { WorkerPoolContext } from './components/WorkerPoolContext'
import { RepositoryProvider } from './gitna/repository'

const GitnaReviewUI = lazy(() =>
  import('./gitna/GitnaReviewUI').then(({ GitnaReviewUI }) => ({ default: GitnaReviewUI })),
)
import './vite/fonts.css'
import './globals.css'

function App() {
  return (
    <>
      <ScrollbarGutterVariables />
      <WorkerPoolContext>
        <ThemeProvider attribute="class">
          <RepositoryProvider>
            <Suspense fallback={null}>
              <GitnaReviewUI />
            </Suspense>
          </RepositoryProvider>
          <div id="dark-mode-portal-container" className="dark" data-theme="dark" />
          <div id="light-mode-portal-container" className="light" data-theme="light" />
        </ThemeProvider>
      </WorkerPoolContext>
      <PreloadHighlighter />
    </>
  )
}

const root = document.getElementById('diffshub-root')
if (root == null) throw new Error('Missing DiffsHub React root')
root.className = 'flex h-dvh min-h-0 flex-col'
createRoot(root).render(<App />)
