<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import ReviewViewer from './components/review/ReviewViewer.svelte'
  import SourceControl from './components/SourceControl.svelte'
  import { createRepoState } from './lib/repo-state.svelte'

  const state = createRepoState()
  let disconnectEvents: (() => void) | undefined

  onMount(() => {
    void state.refreshSnapshot()
    void state.refreshGraph()
    disconnectEvents = state.connectEvents()
  })

  onDestroy(() => {
    disconnectEvents?.()
  })
</script>

<main class="app">
  <SourceControl {state} />
  <ReviewViewer {state} />
</main>
