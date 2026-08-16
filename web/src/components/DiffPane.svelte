<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ChangeDiff } from '../lib/pierre-diff'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { ChangeKind, ChangeScope, FileDiff } from '../lib/types'

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
</script>

<section class="diff-pane" aria-label="Diff">
  <header class="diff-header">
    {#if active}
      <span class="diff-path" title={active.path}>{active.path}</span>
      <span class="diff-scope">{active.scope}</span>
    {:else}
      <span class="diff-empty">Select a change to see its diff</span>
    {/if}
  </header>
  {#if error}
    <p class="diff-message" role="alert">{error}</p>
  {:else if loading}
    <p class="diff-message">Loading diff…</p>
  {:else if diff?.binary}
    <p class="diff-message">Binary file — not shown.</p>
  {:else if diff?.tooLarge}
    <p class="diff-message">File is too large to render.</p>
  {:else if diff}
    <div class="diff-host" bind:this={host}></div>
  {/if}
</section>

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

  .diff-host {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
