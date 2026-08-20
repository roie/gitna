<script lang="ts">
  import { onMount } from 'svelte'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { WorkbenchActions } from '../lib/workbench-actions'
  import Button from './Button.svelte'

  interface Props {
    state: RepoState
    actions: WorkbenchActions
  }

  let { state: repo, actions }: Props = $props()

  let message = $state('')
  let messageInput = $state<HTMLTextAreaElement>()

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

  onMount(() => {
    const unregisterFocus = actions.register('focus-commit', () => messageInput?.focus())
    const unregisterCommit = actions.register('commit', () => {
      if (canCommit) void submit(false)
    })
    return () => {
      unregisterFocus()
      unregisterCommit()
    }
  })
</script>

<section class="composer" aria-label="Commit">
  <textarea
    class="message"
    placeholder="Commit message"
    rows="2"
    bind:this={messageInput}
    bind:value={message}
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
    gap: 6px;
    padding: 8px 12px 10px;
    border-bottom: 1px solid var(--color-border-opaque, var(--border));
    background: var(--diffshub-sidebar-bg, var(--background));
  }

  .message {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    font: inherit;
    font-size: 13px;
    min-height: 48px;
    line-height: 1.4;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--background) 58%, transparent);
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
    gap: 6px;
  }

  .actions :global(.btn) {
    min-height: 28px;
    font-size: 12px;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--destructive, #ef4444);
  }
</style>
