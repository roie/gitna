<script lang="ts">
  import { onMount } from 'svelte'
  import DiffPane from './components/DiffPane.svelte'
  import SourceControl from './components/SourceControl.svelte'
  import { createRepoState } from './lib/repo-state.svelte'

  const state = createRepoState()

  onMount(() => {
    void state.refreshSnapshot()
  })
</script>

<main class="app">
  <SourceControl {state} />
  <DiffPane {state} />
</main>
