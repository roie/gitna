import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DiffIndicators } from '@pierre/diffs'
import { useThemeController } from '@pierre/theming/react'

import { DiffsHubHeader } from './components/DiffsHubHeader'
import { DiffsHubStatusPanel } from './components/DiffsHubStatusPanel'
import { ThemeProvider } from './components/ThemeProvider'
import { ThemeSourceProvider } from './components/ThemeSourceProvider'
import { docsThemeCatalog, themeController } from './components/themeController'
import './vite/fonts.css'
import './globals.css'

function DiffsHubFixtureBaseline() {
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>('expanded')
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split')
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('scroll')
  const [showBackgrounds, setShowBackgrounds] = useState(true)
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars')
  const [lineNumbers, setLineNumbers] = useState(true)
  const [token, setToken] = useState('')
  const themeState = useThemeController(themeController)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setDiffStyle(media.matches ? 'unified' : 'split')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const setColorMode = useCallback(
    (mode: 'light' | 'dark' | 'system') => themeController.setColorMode(mode),
    [],
  )
  const setLightThemeName = useCallback(
    (name: string) => themeController.setThemeNameForScheme('light', name),
    [],
  )
  const setDarkThemeName = useCallback(
    (name: string) => themeController.setThemeNameForScheme('dark', name),
    [],
  )

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer'] md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']">
      <DiffsHubHeader
        className="[grid-area:header]"
        collapseMode={collapseMode}
        colorMode={themeState.mode}
        darkThemeName={themeState.darkThemeName}
        diffIndicators={diffIndicators}
        diffStyle={diffStyle}
        fileTreeAvailable={false}
        fileTreeOverlayOpen={false}
        githubTokenActive={token.length > 0}
        initialUrl="https://github.com/ghostty-org/ghostty/pull/12291"
        lightThemeName={themeState.lightThemeName}
        lineNumbers={lineNumbers}
        overflow={overflow}
        onClearGitHubToken={() => setToken('')}
        onSaveGitHubToken={setToken}
        onToggleCollapseMode={() =>
          setCollapseMode((mode) => (mode === 'expanded' ? 'collapsed' : 'expanded'))
        }
        onToggleFileTreeOverlay={() => {}}
        setColorMode={setColorMode}
        setDarkThemeName={setDarkThemeName}
        setDiffIndicators={setDiffIndicators}
        setDiffStyle={setDiffStyle}
        setLightThemeName={setLightThemeName}
        setLineNumbers={setLineNumbers}
        setOverflow={setOverflow}
        setShowBackgrounds={setShowBackgrounds}
        showBackgrounds={showBackgrounds}
      />
      <DiffsHubStatusPanel errorMessage={null} onRetry={() => {}} state="parsing" />
    </div>
  )
}

function App() {
  useEffect(() => {
    document.body.classList.add('diffshub')
    return () => document.body.classList.remove('diffshub')
  }, [])

  return (
    <ThemeProvider attribute="class">
      <ThemeSourceProvider controller={themeController}>
        <DiffsHubFixtureBaseline />
      </ThemeSourceProvider>
      <div id="dark-mode-portal-container" className="dark" data-theme="dark" />
      <div id="light-mode-portal-container" className="light" data-theme="light" />
    </ThemeProvider>
  )
}

const root = document.getElementById('diffshub-root')
if (root == null) throw new Error('Missing DiffsHub React root')
root.className = 'flex h-dvh min-h-0 flex-col'
createRoot(root).render(<App />)

export { docsThemeCatalog }
