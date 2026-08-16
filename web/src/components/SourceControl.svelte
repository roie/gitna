<script lang="ts">
import type { RepoState } from '../lib/repo-state.svelte'
import type { ChangeScope } from '../lib/types'
import ChangesSection from './ChangesSection.svelte'
import CommitComposer from './CommitComposer.svelte'
import OperationBar from './OperationBar.svelte'

  interface Props {
    state: RepoState
  }

  let { state }: Props = $props()

  let branchLabel = $derived(
    state.snapshot?.headBranch ?? state.snapshot?.headOid?.slice(0, 8) ?? 'no repository',
  )

  function handleSelect(scope: ChangeScope, path: string | null): void {
    if (path) {
      state.select(scope, path)
      return
    }
    if (state.selectedChange?.scope === scope) state.select(scope, null)
  }
</script>

<section class="source-control">
  <header class="sc-header">
    <span class="branch" title={state.snapshot?.root}>{branchLabel}</span>
    <span class="generation">#{state.generation}</span>
    <button
      class="refresh"
      onclick={() => state.refreshSnapshot()}
      disabled={state.loading}
      aria-label="Refresh"
    >
      Refresh
    </button>
  </header>
  <OperationBar repo={state} />
  <ChangesSection
    title="Changes"
    scope="unstaged"
    changes={state.snapshot?.unstaged ?? []}
    selection={state.selection}
    onSelect={handleSelect}
  />
  <ChangesSection
    title="Staged Changes"
    scope="staged"
    changes={state.snapshot?.staged ?? []}
    selection={state.selection}
    onSelect={handleSelect}
  />
  <CommitComposer {state} />
  {#if state.error}
    <p class="error" role="alert">{state.error}</p>
  {/if}
</section>

<style>
  .source-control {
    display: flex;
    flex-direction: column;
    width: 340px;
    min-width: 240px;
    height: 100%;
    border-right: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .sc-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .branch {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .generation {
    font-size: 11px;
    color: var(--color-muted);
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

  .error {
    margin: 0.5rem 0.75rem;
    font-size: 12px;
    color: var(--color-danger);
  }
</style>
