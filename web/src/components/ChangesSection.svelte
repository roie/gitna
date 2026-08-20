<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ChangeTree } from '../lib/pierre-tree'
  import type { Selection } from '../lib/repo-state.svelte'
  import type { ChangeScope, FileChange } from '../lib/types'

  interface Props {
    scope: ChangeScope
    changes: FileChange[]
    selection: Selection | null
    searchOpen?: boolean
    onSelect(scope: ChangeScope, path: string | null): void
  }

  let { scope, changes, selection, searchOpen = false, onSelect }: Props = $props()

  let host: HTMLElement | undefined = $state()
  let tree: ChangeTree | undefined
  const treeHeight = $derived(Math.min(240, Math.max(28, changes.length * 28 + (searchOpen ? 48 : 0))))

  $effect(() => {
    if (!host || tree) return
    tree = new ChangeTree(host, scope, { onSelect })
    tree.update(changes, selection)
  })

  $effect(() => {
    if (!tree) return
    tree.update(changes, selection)
  })

  $effect(() => {
    ;(tree as (ChangeTree & { setSearchOpen(open: boolean): void }) | undefined)?.setSearchOpen(searchOpen)
  })

  onDestroy(() => tree?.destroy())
</script>

<div class="tree-host" style:height={`${treeHeight}px`} bind:this={host}></div>

<style>
  .tree-host {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(240px, 28vh);
    overflow: auto;
    overscroll-behavior: contain;
  }

  .tree-host :global([data-file-tree-container]) {
    height: 100%;
  }
</style>
