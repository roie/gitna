<!--
  Responsive overlay behavior adapted from Pierre DiffsHub ReviewUI.tsx and
  DiffsHubSidebar.tsx at diffs-v1.3.5
  (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb). Ported to Svelte.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import ReviewViewer from './components/review/ReviewViewer.svelte'
  import SourceControl from './components/SourceControl.svelte'
  import { createRepoState } from './lib/repo-state.svelte'
  import { WorkbenchActions } from './lib/workbench-actions'

  const repo = createRepoState()
  const actions = new WorkbenchActions()
  let disconnectEvents: (() => void) | undefined
  let sourceControlOpen = $state(false)
  let sourceControl: HTMLElement | undefined = $state()

  function openSourceControl(): void {
    sourceControlOpen = true
    queueMicrotask(() => sourceControl?.focus())
  }

  function closeSourceControl(): void {
    sourceControlOpen = false
  }

  onMount(() => {
    void repo.refreshSnapshot()
    void repo.refreshGraph()
    disconnectEvents = repo.connectEvents()
    const unregisterFocus = actions.register('focus-source-control', openSourceControl)
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && sourceControlOpen) {
        closeSourceControl()
        return
      }
      actions.handleKeydown(event)
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      unregisterFocus()
      window.removeEventListener('keydown', handleKeydown)
      sourceControlOpen = false
    }
  })

  onDestroy(() => {
    disconnectEvents?.()
  })
</script>

<main class="app">
  <button
    class="source-control-scrim"
    class:open={sourceControlOpen}
    aria-label="Close Source Control"
    tabindex={sourceControlOpen ? 0 : -1}
    onclick={closeSourceControl}
  ></button>
  <aside
    class="source-control-shell"
    class:open={sourceControlOpen}
    aria-label="Source Control"
    tabindex="-1"
    bind:this={sourceControl}
  >
    <SourceControl state={repo} {actions} onClose={closeSourceControl} />
  </aside>
  <ReviewViewer state={repo} {actions} onOpenSourceControl={openSourceControl} />
</main>
