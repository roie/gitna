import { createRoot } from 'react-dom/client'

import { PreloadHighlighter } from './components/PreloadHighlighter'
import { ScrollbarGutterVariables } from './components/ScrollbarGutterVariables'
import { ThemeProvider } from './components/ThemeProvider'
import { WorkerPoolContext } from './components/WorkerPoolContext'
import { GitnaReviewUI } from './gitna/GitnaReviewUI'
import { RepositoryProvider } from './gitna/repository'
import './vite/fonts.css'
import './globals.css'

function App() {
  return (
    <>
      <ScrollbarGutterVariables />
      <WorkerPoolContext>
        <ThemeProvider attribute="class">
          <RepositoryProvider>
            <GitnaReviewUI />
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
