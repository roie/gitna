<!--
  Modified from Pierre DiffsHub components/DiffsHubStatusPanel.tsx at
  diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported from React to Svelte and adapted to local repository review states.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import Button from '../Button.svelte'

  interface Props {
    state: 'loading' | 'error' | 'empty'
    error?: string | null
    onRetry?: () => void
  }

  let { state, error = null, onRetry }: Props = $props()
  const title = $derived(state === 'error' ? 'Couldn’t load review' : state === 'empty' ? 'No changes to review' : 'Preparing review')
  const message = $derived(
    state === 'error'
      ? (error ?? 'The repository changed or the review could not be loaded.')
      : state === 'empty'
        ? 'This scope has no file changes.'
        : 'Parsing the bounded patch and preparing the continuous file view…',
  )
</script>

<section
  class="status"
  role={state === 'error' ? 'alert' : 'status'}
  aria-live="polite"
  aria-busy={state === 'loading' || undefined}
>
  {#if state === 'loading'}
    <svg class="spinner" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="30 14" />
    </svg>
  {:else if state === 'error'}
    <svg class="icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.8 18 17H2L10 2.8Z" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M10 7v4.5m0 2.5v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  {/if}
  <h2>{title}</h2>
  <p>{message}</p>
  {#if state === 'error' && onRetry}
    <Button size="sm" onclick={onRetry}>Try again</Button>
  {/if}
</section>

<style>
  .status {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    min-height: 0;
    height: 100%;
    padding: 24px;
    text-align: center;
    color: var(--muted-foreground);
  }
  h2 { margin: 0; color: var(--foreground); font-size: 14px; font-weight: 500; }
  p { max-width: 44ch; margin: 0 0 8px; font-size: 13px; line-height: 1.45; text-wrap: pretty; }
  .spinner, .icon { width: 20px; height: 20px; }
  .spinner { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
