<script lang="ts">
  import type { RepoState } from '../lib/repo-state.svelte'
  import GraphRow from './GraphRow.svelte'

  interface Props {
    state: RepoState
  }

  let { state }: Props = $props()
</script>

<section class="graph-section" aria-label="Graph">
  <header class="graph-header">
    <span class="title">Graph</span>
    <button
      class="refresh"
      onclick={() => void state.refreshGraph()}
      disabled={state.graphLoading}
      aria-label="Refresh graph"
    >
      Refresh
    </button>
  </header>
  {#if state.graphRows.length === 0}
    <p class="graph-message" class:alert={!!state.graphError} role={state.graphError ? 'alert' : undefined}>
      {state.graphError ?? (state.graphLoading ? 'Loading graph…' : 'No commits yet')}
    </p>
  {:else}
    <ul class="graph-list">
      {#each state.graphRows as row (row.commit.oid)}
        <GraphRow {row} {state} />
      {/each}
    </ul>
    {#if state.graphHasMore}
      <button class="load-more" onclick={() => void state.loadMoreGraph()} disabled={state.graphLoading}>
        Load more
      </button>
    {/if}
  {/if}
</section>

<style>
  .graph-section {
    display: flex;
    flex-direction: column;
    width: 300px;
    min-width: 240px;
    height: 100%;
    border-right: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .graph-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
  }

  .refresh {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .refresh:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .graph-message {
    margin: 1rem 0.75rem;
    font-size: 12px;
    color: var(--color-muted);
  }

  .graph-message[role='alert'] {
    color: var(--color-danger);
  }

  .graph-list {
    flex: 1;
    margin: 0;
    padding: 4px 0;
    list-style: none;
    overflow-y: auto;
  }

  .load-more {
    margin: 0.5rem 0.75rem;
    font-size: 11px;
    padding: 3px 10px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .load-more:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
