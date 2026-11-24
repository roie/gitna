// Modified by Gitna: compose the standalone entry, native providers and local sessions.
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/app'
import { Theme } from './lib/theme/theme-root'
import { startPreferenceSync } from './lib/preferences'

const pdfPath = new URLSearchParams(window.location.search).get('pdf')
const StandalonePDF = lazy(() =>
  import('./features/viewer/preview/pdf-preview').then(({ PDFPreview }) => ({
    default: PDFPreview,
  })),
)
import './styles/fonts.css'
import '@pierre/words/styles.css'
import './styles/globals.css'

const root = document.getElementById('root')
if (root == null) throw new Error('Missing Gitna React root')
root.className = 'flex h-dvh min-h-0 flex-col'
startPreferenceSync()
async function mountApp(root: HTMLElement): Promise<void> {
  const Workbench = pdfPath == null ? (await import('./app/workbench')).Workbench : null
  const standalone =
    pdfPath == null ? undefined : (
      <Theme>
        <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Media preview">
          <Suspense fallback={null}>
            <StandalonePDF path={pdfPath} standalone />
          </Suspense>
        </section>
      </Theme>
    )
  createRoot(root).render(<App Workbench={Workbench} standalone={standalone} />)
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
