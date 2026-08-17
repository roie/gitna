<script lang="ts">
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { ConflictEntry } from '../lib/types'

  interface Props {
    state: RepoState
  }

  let { state: repo }: Props = $props()

  let actionError = $state<string | null>(null)

  const operation = $derived(repo.snapshot?.operation ?? 'none')
  const isMerge = $derived(operation === 'merge')
  const isRebase = $derived(operation === 'rebase')
  const isActive = $derived(isMerge || isRebase)

  async function run(action: () => Promise<void>): Promise<void> {
    actionError = null
    try {
      await action()
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e)
    }
  }

  function handleResolveOurs(path: string): void {
    void run(() => repo.resolveOurs(path))
  }

  function handleResolveTheirs(path: string): void {
    void run(() => repo.resolveTheirs(path))
  }

  function handleContinue(): void {
    if (isMerge) {
      void run(() => repo.mergeContinue())
    } else if (isRebase) {
      void run(() => repo.rebaseContinue())
    }
  }

  function handleAbort(): void {
    if (isMerge) {
      void run(() => repo.mergeAbort())
    } else if (isRebase) {
      void run(() => repo.rebaseAbort())
    }
  }
</script>

{#if isActive}
  <div class="conflict-bar">
    <div class="conflict-header">
      <span class="conflict-label">
        {isMerge ? 'Merge' : 'Rebase'} in progress
      </span>
      <button class="conflict-action" onclick={handleAbort} disabled={repo.busy}>
        Abort
      </button>
    </div>
    {#if repo.conflicts.length > 0}
      <ul class="conflict-list">
        {#each repo.conflicts as entry (entry.path)}
          <li class="conflict-item">
            <span class="conflict-path" title={entry.path}>{entry.path}</span>
            <span class="conflict-buttons">
              <button
                class="conflict-resolve"
                onclick={() => handleResolveOurs(entry.path)}
                disabled={repo.busy}
                title="Keep our version"
              >
                Ours
              </button>
              <button
                class="conflict-resolve"
                onclick={() => handleResolveTheirs(entry.path)}
                disabled={repo.busy}
                title="Keep their version"
              >
                Theirs
              </button>
            </span>
          </li>
        {/each}
      </ul>
      <button
        class="conflict-continue"
        onclick={handleContinue}
        disabled={repo.busy || repo.conflictsLoading}
      >
        Continue
      </button>
    {:else if repo.conflictsLoading}
      <p class="conflict-note">Loading conflicts…</p>
    {:else}
      <p class="conflict-note">No unmerged files</p>
    {/if}
    {#if actionError}
      <p class="conflict-error" role="alert">{actionError}</p>
    {/if}
  </div>
{/if}

<style>
  .conflict-bar {
    padding: 0.4rem 0.75rem 0.55rem;
    border-bottom: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    font-size: 12px;
  }

  .conflict-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.35rem;
  }

  .conflict-label {
    flex: 1;
    font-weight: 600;
    color: var(--color-danger);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conflict-action {
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-danger);
    font-size: 11px;
    cursor: pointer;
  }

  .conflict-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .conflict-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .conflict-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 3px 0;
  }

  .conflict-item + .conflict-item {
    border-top: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
  }

  .conflict-path {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .conflict-buttons {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .conflict-resolve {
    padding: 1px 6px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: transparent;
    color: var(--color-fg);
    font-size: 10px;
    cursor: pointer;
  }

  .conflict-resolve:hover:not(:disabled) {
    background: var(--color-selected-bg);
  }

  .conflict-resolve:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .conflict-continue {
    width: 100%;
    margin-top: 0.35rem;
    padding: 3px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-selected-bg);
    color: var(--color-fg);
    font-size: 11px;
    cursor: pointer;
  }

  .conflict-continue:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .conflict-note {
    margin: 0;
    font-size: 11px;
    color: var(--color-muted);
  }

  .conflict-error {
    margin: 0.35rem 0 0;
    color: var(--color-danger);
    word-break: break-word;
  }
</style>
