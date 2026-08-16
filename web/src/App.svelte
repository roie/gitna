<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import DiffPane from './components/DiffPane.svelte'
  import GraphSection from './components/GraphSection.svelte'
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
  <GraphSection {state} />
  <DiffPane {state} />
</main>
