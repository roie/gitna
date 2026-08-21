// Pre-paint boundary aligned with the pinned DiffsHub theme controller.
const MODE_KEY = 'theme'

try {
  const saved = localStorage.getItem(MODE_KEY)
  const mode = saved === 'light' || saved === 'dark' ? saved : 'system'
  const dark =
    mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
} catch {
  // Storage can be unavailable; CSS prefers-color-scheme remains the fallback.
}
