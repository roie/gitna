<!--
  Modified from Pierre DiffsHub components/DropdownMenu.tsx and
  lib/theme/dropdownChromeStyle.ts at diffs-v1.3.5
  (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Replaced Radix/React with a Svelte popover while preserving chrome geometry,
  focus, hover, border, and elevated-surface behavior.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import { onDestroy, onMount, type Snippet } from 'svelte'

  interface Props {
    ariaLabel: string
    align?: 'start' | 'end'
    class?: string
    trigger: Snippet<[toggle: () => void, open: boolean]>
    children: Snippet<[close: () => void]>
  }

  let { ariaLabel, align = 'end', class: className = '', trigger, children }: Props = $props()
  let root = $state<HTMLDivElement>()
  let surface = $state<HTMLDivElement>()
  let open = $state(false)

  function close(): void {
    open = false
  }

  function toggle(): void {
    open = !open
  }

  function handlePointer(event: PointerEvent): void {
    if (open && root && !root.contains(event.target as Node)) close()
  }

  function handleKey(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return
    event.preventDefault()
    close()
    root?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
  }

  onMount(() => {
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
  })

  onDestroy(() => {
    document.removeEventListener('pointerdown', handlePointer)
    document.removeEventListener('keydown', handleKey)
  })

  $effect(() => {
    if (open) queueMicrotask(() => surface?.focus())
  })
</script>

<div class="dropdown {className}" bind:this={root}>
  {@render trigger(toggle, open)}
  {#if open}
    <div
      class="surface align-{align}"
      bind:this={surface}
      role="menu"
      aria-label={ariaLabel}
      tabindex="-1"
    >
      {@render children(close)}
    </div>
  {/if}
</div>

<style>
  .dropdown {
    position: relative;
    display: inline-flex;
  }

  .surface {
    position: absolute;
    z-index: 60;
    top: calc(100% + 6px);
    width: 288px;
    max-width: min(288px, calc(100vw - 24px));
    padding: 8px;
    border: 1px solid var(--diffshub-popover-border, var(--color-border));
    border-radius: 8px;
    background: var(--diffshub-popover-bg, var(--popover));
    color: var(--diffshub-popover-fg, var(--popover-foreground));
    box-shadow: var(--diffshub-popover-shadow, 0 8px 24px rgb(0 0 0 / 0.12));
    outline: none;
  }

  .align-start { left: 0; }
  .align-end { right: 0; }
</style>
