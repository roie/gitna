<!--
  Modified from Pierre DiffsHub components/ThemedSurface.tsx at
  diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Adapted from React to a Svelte chrome host; theme variables are applied by the
  shared controller at the document root. Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    class?: string
    children: Snippet
  }

  let { class: className = '', children }: Props = $props()
</script>

<div class={className} data-themed-surface="true">
  {@render children()}
</div>
