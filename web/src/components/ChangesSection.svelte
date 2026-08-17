<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ChangeTree } from '../lib/pierre-tree'
  import type { Selection } from '../lib/repo-state.svelte'
  import type { ChangeScope, FileChange } from '../lib/types'

  interface Props {
    scope: ChangeScope
    changes: FileChange[]
    selection: Selection | null
    onSelect(scope: ChangeScope, path: string | null): void
  }

  let { scope, changes, selection, onSelect }: Props = $props()

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

<div class="tree-host" bind:this={host}></div>

<style>
  .tree-host {
    flex: 1;
    min-height: 48px;
    max-height: 240px;
    overflow: auto;
  }

  .tree-host :global([data-file-tree-container]) {
    height: 100%;
  }
</style>
