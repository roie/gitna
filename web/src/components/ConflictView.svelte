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
  const isCherryPick = $derived(operation === 'cherry-pick')
  const isRevert = $derived(operation === 'revert')
  const isActive = $derived(isMerge || isRebase || isCherryPick || isRevert)
  const operationLabel = $derived(
    isMerge ? 'Merge' : isRebase ? 'Rebase' : isCherryPick ? 'Cherry-pick' : 'Revert',
  )
  const unresolvedConflicts = $derived.by(() => {
    const snapshot = repo.snapshot
    if (!snapshot) return repo.conflicts
    const paths = new Set(
      [...snapshot.staged, ...snapshot.unstaged]
        .filter((change) => change.conflicted)
        .map((change) => change.path),
    )
    return repo.conflicts.filter((entry) => paths.has(entry.path))
  })

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

  function handleResolveBoth(path: string): void {
    void run(() => repo.resolveBoth(path))
  }

  function handleStageEdited(path: string): void {
    void run(() => repo.mutate({ op: 'stage', paths: [path] }))
  }

  function handleContinue(): void {
    if (isMerge) void run(() => repo.mergeContinue())
    else if (isRebase) void run(() => repo.rebaseContinue())
    else if (isCherryPick) void run(() => repo.cherryPickContinue())
    else if (isRevert) void run(() => repo.revertContinue())
  }

  function handleAbort(): void {
    if (isMerge) void run(() => repo.mergeAbort())
    else if (isRebase) void run(() => repo.rebaseAbort())
    else if (isCherryPick) void run(() => repo.cherryPickAbort())
    else if (isRevert) void run(() => repo.revertAbort())
  }
</script>

{#if isActive}
  <div class="conflict-bar">
    <div class="conflict-header">
      <span class="conflict-label">
        {operationLabel} in progress
      </span>
      <Button variant="destructive" size="xs" onclick={handleAbort} disabled={repo.busy}>
        Abort
      </Button>
    </div>
    {#if unresolvedConflicts.length > 0}
      <ul class="conflict-list">
        {#each unresolvedConflicts as entry (entry.path)}
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
              {#if entry.canResolveBoth}
                <Button
                  variant="outline"
                  size="xs"
                  onclick={() => handleResolveBoth(entry.path)}
                  disabled={repo.busy}
                  title="Union both text versions"
                >
                  Both
                </Button>
              {/if}
              <Button
                variant="ghost"
                size="xs"
                onclick={() => handleStageEdited(entry.path)}
                disabled={repo.busy}
                title="Stage the externally edited file as resolved"
              >
                Stage edited
              </Button>
            </span>
          </li>
        {/each}
      </ul>
    {:else if repo.conflictsLoading}
      <p class="conflict-note">Loading conflicts…</p>
    {:else}
      <p class="conflict-note">All conflicts resolved and staged.</p>
    {/if}
    {#if repo.conflictsError}
      <p class="conflict-error" role="alert">{repo.conflictsError}</p>
    {/if}
    <Button
      variant="outline"
      size="sm"
      onclick={handleContinue}
      disabled={repo.busy || repo.conflictsLoading || unresolvedConflicts.length > 0}
    >
      Continue
    </Button>
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
