<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ChangeDiff } from '../lib/pierre-diff'
  import { splitHunkPatches, type HunkPatch } from '../lib/hunk-patches'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { ChangeKind, ChangeScope, FileDiff } from '../lib/types'
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    state: RepoState
  }

  // Destructured as `repo` so the local binding does not shadow the `$state`
  // rune name.
  let { state: repo }: Props = $props()

  interface ActiveDiff {
    scope: ChangeScope
    path: string
    oldPath?: string
    kind: ChangeKind
  }

  let active = $derived.by<ActiveDiff | null>(() => {
    const change = repo.selectedChange
    if (!change) return null
    return {
      scope: change.scope,
      path: change.path,
      oldPath: change.oldPath,
      kind: change.kind,
    }
  })

  let host: HTMLElement | undefined = $state()
  let diffView: ChangeDiff | undefined = $state()
  let diff = $state<FileDiff | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)

  interface ConfirmRequest {
    title: string
    message: string
    confirmLabel: string
    onConfirm(): void
  }
  let pendingConfirm = $state<ConfirmRequest | null>(null)

  let fetchSeq = 0

  async function load(change: ActiveDiff): Promise<void> {
    const seq = ++fetchSeq
    loading = true
    error = null
    try {
      const result = await repo.api.diff({
        scope: change.scope,
        path: change.path,
        oldPath: change.oldPath,
      })
      if (seq !== fetchSeq) return
      diff = result
    } catch (e) {
      if (seq !== fetchSeq) return
      error = e instanceof Error ? e.message : String(e)
    } finally {
      if (seq === fetchSeq) loading = false
    }
  }

  $effect(() => {
    const change = active
    if (!change) {
      fetchSeq += 1
      diff = null
      error = null
      loading = false
      return
    }
    void load(change)
  })

  // The view's lifecycle is tied to the current host div. The template can
  // replace the host (loading/error/binary states unmount it), so a new
  // ChangeDiff is created whenever the host element is (re)bound.
  $effect(() => {
    const mount = host
    if (!mount) return
    const view = new ChangeDiff(mount)
    diffView = view
    return () => {
      view.destroy()
    }
  })

  $effect(() => {
    if (!diffView || !diff || !active) return
    diffView.update(diff, active.kind)
  })

  onDestroy(() => {
    fetchSeq += 1
  })

  const hunks = $derived.by<HunkPatch[]>(() => {
    const patch = diff?.patch
    if (!patch || !active || active.kind !== 'modified') return []
    return splitHunkPatches(patch)
  })

  function stageFile(): void {
    if (!active) return
    void repo.mutate({ op: 'stage', paths: [active.path] })
  }

  function unstageFile(): void {
    if (!active) return
    void repo.mutate({ op: 'unstage', paths: [active.path] })
  }

  function confirmDiscard(): void {
    if (!active) return
    pendingConfirm = {
      title: 'Discard changes',
      message: `Discard local changes to ${active.path}? This cannot be undone.`,
      confirmLabel: 'Discard',
      onConfirm: () => {
        pendingConfirm = null
        void repo.mutate({ op: 'discard', paths: [active.path] })
      },
    }
  }

  function confirmDelete(): void {
    if (!active) return
    pendingConfirm = {
      title: 'Delete file',
      message: `Permanently delete untracked file ${active.path}? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => {
        pendingConfirm = null
        void repo.mutate({ op: 'delete', paths: [active.path] })
      },
    }
  }

  function applyHunk(hunk: HunkPatch, reverse: boolean): void {
    if (!active) return
    void repo.mutate({ op: 'patch', patch: hunk.patch, reverse })
  }
</script>

<section class="diff-pane" aria-label="Diff">
  <header class="diff-header">
    {#if active}
      <span class="diff-path" title={active.path}>{active.path}</span>
      <span class="diff-scope">{active.scope}</span>
      {#if active.scope === 'unstaged'}
        <button class="action" onclick={stageFile} disabled={repo.busy || loading}>Stage</button>
        {#if active.kind === 'untracked'}
          <button class="action action-danger" onclick={confirmDelete} disabled={repo.busy}>
            Delete
          </button>
        {:else}
          <button class="action action-danger" onclick={confirmDiscard} disabled={repo.busy}>
            Discard
          </button>
        {/if}
      {:else}
        <button class="action" onclick={unstageFile} disabled={repo.busy || loading}>Unstage</button>
      {/if}
    {:else}
      <span class="diff-empty">Select a change to see its diff</span>
    {/if}
  </header>
  {#if error}
    <p class="diff-message" role="alert">{error}</p>
  {:else if repo.mutationError}
    <p class="diff-message" role="alert">{repo.mutationError}</p>
  {:else if loading}
    <p class="diff-message">Loading diff…</p>
  {:else if diff?.binary}
    <p class="diff-message">Binary file — not shown.</p>
  {:else if diff?.tooLarge}
    <p class="diff-message">File is too large to render.</p>
  {:else if diff}
    <div class="diff-host" bind:this={host}></div>
    {#if hunks.length > 0}
      <div class="hunk-strip">
        <span class="hunk-label">Hunks</span>
        {#each hunks as hunk, i (hunk.range)}
          <span class="hunk-chip">
            <code class="hunk-range" title={hunk.range}>#{i + 1}</code>
            {#if active?.scope === 'staged'}
              <button
                class="hunk-button"
                onclick={() => applyHunk(hunk, true)}
                disabled={repo.busy}
              >
                Unstage
              </button>
            {:else}
              <button
                class="hunk-button"
                onclick={() => applyHunk(hunk, false)}
                disabled={repo.busy}
              >
                Stage
              </button>
            {/if}
          </span>
        {/each}
      </div>
    {/if}
  {/if}
</section>

{#if pendingConfirm}
  <ConfirmDialog
    title={pendingConfirm.title}
    message={pendingConfirm.message}
    confirmLabel={pendingConfirm.confirmLabel}
    onConfirm={pendingConfirm.onConfirm}
    onCancel={() => (pendingConfirm = null)}
  />
{/if}

<style>
  .diff-pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    height: 100%;
    background: var(--color-bg);
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .diff-path {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diff-scope {
    font-size: 11px;
    color: var(--color-muted);
    text-transform: capitalize;
  }

  .diff-empty {
    font-size: 12px;
    color: var(--color-muted);
  }

  .diff-message {
    margin: 1rem 0.75rem;
    font-size: 12px;
    color: var(--color-muted);
  }

  .diff-message[role='alert'] {
    color: var(--color-danger);
  }

  .action {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .action-danger {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .diff-host {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .hunk-strip {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--color-border);
  }

  .hunk-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }

  .hunk-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
  }

  .hunk-range {
    font-size: 11px;
    color: var(--color-muted);
  }

  .hunk-button {
    font-size: 11px;
    padding: 1px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .hunk-button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
