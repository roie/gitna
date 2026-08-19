<script lang="ts">
  import type { RepoState } from '../lib/repo-state.svelte'
  import Button from './Button.svelte'

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
      <Button variant="destructive" size="xs" onclick={handleAbort} disabled={repo.busy}>
        Abort
      </Button>
    </div>
    {#if repo.conflicts.length > 0}
      <ul class="conflict-list">
        {#each repo.conflicts as entry (entry.path)}
          <li class="conflict-item">
            <span class="conflict-path" title={entry.path}>{entry.path}</span>
            <span class="conflict-buttons">
              <Button
                variant="outline"
                size="xs"
                onclick={() => handleResolveOurs(entry.path)}
                disabled={repo.busy}
                title="Keep our version"
              >
                Ours
              </Button>
              <Button
                variant="outline"
                size="xs"
                onclick={() => handleResolveTheirs(entry.path)}
                disabled={repo.busy}
                title="Keep their version"
              >
                Theirs
              </Button>
            </span>
          </li>
        {/each}
      </ul>
      <Button
        variant="outline"
        size="sm"
        onclick={handleContinue}
        disabled={repo.busy || repo.conflictsLoading}
      >
        Continue
      </Button>
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
    padding: 4px 8px 8px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--destructive, #ef4444) 8%, transparent);
    font-size: 13px;
  }

  .conflict-header {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 4px;
  }

  .conflict-label {
    flex: 1;
    font-weight: 600;
    color: var(--destructive, #ef4444);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conflict-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .conflict-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 0;
  }

  .conflict-item + .conflict-item {
    border-top: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }

  .conflict-path {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .conflict-buttons {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .conflict-note {
    margin: 0;
    font-size: 12px;
    color: var(--muted-foreground);
  }

  .conflict-error {
    margin: 4px 0 0;
    color: var(--destructive, #ef4444);
    word-break: break-word;
  }
</style>
