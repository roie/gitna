const root = document.documentElement

try {
  const cached = JSON.parse(localStorage.getItem('diffshub-theme-tokens') ?? 'null')
  if (cached != null && typeof cached === 'object') {
    for (const [name, cssValue] of Object.entries(cached)) {
      if (typeof cssValue !== 'string') continue
      if (name === 'color-scheme') root.style.colorScheme = cssValue
      else root.style.setProperty(name, cssValue)
    }
  }
} catch {}

try {
  const saved = localStorage.getItem('theme')
  const dark =
    saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
} catch {
  root.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
}

const startupHeadingObserver = new MutationObserver(() => {
  const heading = document.getElementById('startup-title')
  if (heading == null) return
  startupHeadingObserver.disconnect()
  if (new URLSearchParams(location.search).has('pdf')) {
    heading.textContent = 'Opening preview'
  } else {
    try {
      const name = decodeURIComponent(
        location.pathname.split('/').filter(Boolean).at(-1) ?? 'folder',
      )
      heading.textContent = `Opening ${name}`
      heading.title = heading.textContent
    } catch {
      heading.textContent = 'Opening folder'
    }
  }
})
startupHeadingObserver.observe(document.documentElement, { childList: true, subtree: true })
