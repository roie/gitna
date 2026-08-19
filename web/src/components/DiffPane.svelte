<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ChangeDiff } from '../lib/pierre-diff'
  import { splitHunkPatches, type HunkPatch } from '../lib/hunk-patches'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { ChangeKind, DiffScope, FileDiff } from '../lib/types'
  import Button from './Button.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    state: RepoState
  }

  let { state: repo }: Props = $props()

  interface ActiveDiff {
    scope: DiffScope
    path: string
    oldPath?: string
    kind: ChangeKind
    commit?: string
    subject?: string
    from?: string
    to?: string
  }

  let active = $derived.by<ActiveDiff | null>(() => {
    const compareDiff = repo.compareDiff
    if (compareDiff) {
      return {
        scope: 'compare',
        path: compareDiff.path,
        oldPath: compareDiff.oldPath,
        kind: compareDiff.kind,
        from: compareDiff.from,
        to: compareDiff.to,
      }
    }
    const commitDiff = repo.commitDiff
    if (commitDiff) {
      return {
        scope: 'commit',
        path: commitDiff.path,
        oldPath: commitDiff.oldPath,
        kind: commitDiff.kind,
        commit: commitDiff.oid,
        subject: commitDiff.subject,
      }
    }
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
        commit: change.commit,
        from: change.from,
        to: change.to,
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
    if (!patch || !active || (active.scope !== 'staged' && active.scope !== 'unstaged') || active.kind !== 'modified') return []
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
      <span class="diff-path" title={active.path}>
        {#if active.scope === 'commit' && active.subject}
          <span class="diff-subject">{active.subject}</span>
        {/if}
        {active.path}
      </span>
      <span class="diff-scope">{active.scope}</span>
      {#if active.scope === 'commit'}
        <span class="diff-commit" title={active.commit}>{active.commit?.slice(0, 8)}</span>
      {:else if active.scope === 'compare'}
        <span class="diff-commit" title={`${active.from}..${active.to}`}>
          {active.from?.slice(0, 8)}..{active.to?.slice(0, 8)}
        </span>
      {:else if active.scope === 'unstaged'}
        <Button variant="outline" size="sm" onclick={stageFile} disabled={repo.busy || loading}>Stage</Button>
        {#if active.kind === 'untracked'}
          <Button variant="destructive" size="sm" onclick={confirmDelete} disabled={repo.busy}>
            Delete
          </Button>
        {:else}
          <Button variant="destructive" size="sm" onclick={confirmDiscard} disabled={repo.busy}>
            Discard
          </Button>
        {/if}
      {:else}
        <Button variant="outline" size="sm" onclick={unstageFile} disabled={repo.busy || loading}>Unstage</Button>
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
              <Button
                variant="ghost"
                size="xs"
                onclick={() => applyHunk(hunk, true)}
                disabled={repo.busy}
              >
                Unstage
              </Button>
            {:else}
              <Button
                variant="ghost"
                size="xs"
                onclick={() => applyHunk(hunk, false)}
                disabled={repo.busy}
              >
                Stage
              </Button>
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
    background: var(--background);
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--border);
  }

  .diff-path {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diff-scope {
    font-size: 12px;
    color: var(--muted-foreground);
    text-transform: capitalize;
  }

  .diff-subject {
    font-weight: 500;
  }

  .diff-subject::after {
    content: ' · ';
    color: var(--muted-foreground);
  }

  .diff-commit {
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--muted-foreground);
  }

  .diff-empty {
    font-size: 13px;
    color: var(--muted-foreground);
  }

  .diff-message {
    margin: 16px 8px;
    font-size: 13px;
    color: var(--muted-foreground);
  }

  .diff-message[role='alert'] {
    color: var(--destructive, #ef4444);
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
    gap: 8px;
    padding: 8px;
    border-top: 1px solid var(--border);
  }

  .hunk-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted-foreground);
  }

  .hunk-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  .hunk-range {
    font-size: 12px;
    color: var(--muted-foreground);
  }
</style>
