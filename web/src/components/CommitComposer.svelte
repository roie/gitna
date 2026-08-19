<script lang="ts">
  import type { RepoState } from '../lib/repo-state.svelte'
  import Button from './Button.svelte'

  interface Props {
    state: RepoState
  }

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
    <Button variant="default" size="sm" onclick={() => submit(false)} disabled={!canCommit}>
      Commit
    </Button>
    <Button
      variant="outline"
      size="sm"
      onclick={() => submit(true)}
      disabled={!canCommit}
      title="Replace the last commit with these changes"
    >
      Amend
    </Button>
  </div>
  {#if repo.mutationError}
    <p class="error" role="alert">{repo.mutationError}</p>
  {/if}
</section>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border-top: 1px solid var(--border);
  }

  .message {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    outline: none;
  }

  .message:focus-visible {
    border-color: var(--ring);
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
  }

  .message::placeholder {
    color: var(--muted-foreground);
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--destructive, #ef4444);
  }
</style>
