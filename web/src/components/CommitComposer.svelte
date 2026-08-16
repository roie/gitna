<script lang="ts">
  import type { RepoState } from '../lib/repo-state.svelte'

  interface Props {
    state: RepoState
  }

  // Destructured as `repo` so the local binding does not shadow the `$state`
  // rune name.
  let { state: repo }: Props = $props()

  let message = $state('')

  const stagedCount = $derived(repo.snapshot?.staged.length ?? 0)
  const canCommit = $derived(stagedCount > 0 && message.trim().length > 0 && !repo.busy)

  async function submit(amend: boolean): Promise<void> {
    const text = message
    try {
      await repo.commit(text, amend)
      message = ''
    } catch {
      // repo.mutationError shows the hook's reason; keep the user's text.
    }
  }
</script>

<section class="composer" aria-label="Commit">
  <textarea
    class="message"
    placeholder="Commit message"
    rows="2"
    bind:value={message}
    onkeydown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(false)
    }}
  ></textarea>
  <div class="actions">
    <button class="action primary" onclick={() => submit(false)} disabled={!canCommit}>
      Commit
    </button>
    <button
      class="action"
      onclick={() => submit(true)}
      disabled={!canCommit}
      title="Replace the last commit with these changes"
    >
      Amend
    </button>
  </div>
  {#if repo.mutationError}
    <p class="error" role="alert">{repo.mutationError}</p>
  {/if}
</section>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--color-border);
  }

  .message {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    font: inherit;
    font-size: 12px;
    line-height: 1.4;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-fg);
  }

  .message::placeholder {
    color: var(--color-muted);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .action {
    font-size: 11px;
    padding: 3px 10px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .action.primary {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--color-danger);
  }
</style>
