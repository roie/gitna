<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import DiffPane from './components/DiffPane.svelte'
  import SourceControl from './components/SourceControl.svelte'
  import { applyChromeTheme } from './lib/chrome-theme'
  import { createRepoState } from './lib/repo-state.svelte'

  const state = createRepoState()
  let disconnectEvents: (() => void) | undefined

  function applyTheme(): void {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.classList.toggle('light', !dark)

    void import('@pierre/theme/themes/pierre-dark.json').then((mod) => {
      const theme = (mod as { default: Record<string, unknown> }).default
      applyChromeTheme(theme as Parameters<typeof applyChromeTheme>[0])
    })
  }

  onMount(() => {
    applyTheme()
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
    void state.refreshSnapshot()
    void state.refreshGraph()
    disconnectEvents = state.connectEvents()
  })

  onDestroy(() => {
    disconnectEvents?.()
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', applyTheme)
  })
</script>

<main class="app">
  <SourceControl {state} />
  <DiffPane {state} />
</main>
