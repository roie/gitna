<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ChangeTree } from '../lib/pierre-tree'
  import type { Selection } from '../lib/repo-state.svelte'
  import type { ChangeScope, FileChange } from '../lib/types'

  interface Props {
    title: string
    scope: ChangeScope
    changes: FileChange[]
    selection: Selection | null
    onSelect(scope: ChangeScope, path: string | null): void
  }

  let { title, scope, changes, selection, onSelect }: Props = $props()

  let host: HTMLElement | undefined = $state()
  let tree: ChangeTree | undefined

  $effect(() => {
    if (!host || tree) return
    tree = new ChangeTree(host, scope, { onSelect })
    tree.update(changes, selection)
  })

  $effect(() => {
    if (!tree) return
    tree.update(changes, selection)
  })

  onDestroy(() => tree?.destroy())
</script>

<section class="changes-section">
  <header class="changes-header">
    <h2 class="changes-title">{title}</h2>
    <span class="count">{changes.length}</span>
  </header>
  <div class="tree-host" bind:this={host}></div>
</section>

<style>
  .changes-section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .changes-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .changes-title {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }

  .count {
    font-size: 11px;
    color: var(--color-muted);
  }

  .tree-host {
    flex: 1;
    min-height: 96px;
    overflow: auto;
  }

  .tree-host :global([data-file-tree-container]) {
    height: 100%;
  }
</style>
