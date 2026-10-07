try {
  const saved = localStorage.getItem('theme')
  const dark =
    saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
} catch {
  document.documentElement.classList.toggle(
    'dark',
    matchMedia('(prefers-color-scheme: dark)').matches,
  )
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
