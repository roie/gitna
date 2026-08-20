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
  const treeHeight = $derived(Math.min(288, Math.max(24, changes.length * 24 + (searchOpen ? 52 : 0))))

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
    max-width: calc(100% - 24px);
    max-height: min(288px, 36vh);
    margin-left: 12px;
    margin-right: 12px;
    overflow: auto;
    overscroll-behavior: contain;
  }

  .tree-host :global([data-file-tree-container]) {
    height: 100%;
  }

  @media (width <= 767px) {
    .tree-host {
      max-width: 100%;
      margin-left: 0;
    }
  }
</style>
