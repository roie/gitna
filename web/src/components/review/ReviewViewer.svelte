<!--
  Modified from Pierre DiffsHub ReviewUI.tsx, DiffsHubViewer.tsx, and
  ThemedCodeView.tsx at diffs-v1.3.5
  (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported from React to Svelte around one long-lived vanilla CodeView.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { ReviewRequest } from '../../lib/api'
  import { ReviewCodeView, type CodeViewDisplayOptions } from '../../lib/code-view'
  import { reviewPreferences } from '../../lib/review-preferences.svelte'
  import type { RepoState } from '../../lib/repo-state.svelte'
  import type { ReviewResponse } from '../../lib/types'
  import ThemedSurface from '../ThemedSurface.svelte'
  import ReviewHeader from './ReviewHeader.svelte'
  import ReviewStatus from './ReviewStatus.svelte'

  interface Props { state: RepoState }
  interface Target { key: string; title: string; request: ReviewRequest; path?: string }

  let { state: repo }: Props = $props()
  let host = $state<HTMLDivElement>()
  let controller: ReviewCodeView | null = null
  let review = $state<ReviewResponse | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let fileCount = $state(0)
  let collapsed = $state(false)
  let narrow = $state(false)
  let requestVersion = 0

  const target = $derived.by<Target | null>(() => {
    if (repo.compare) {
      return {
        key: `compare:${repo.compare.from}:${repo.compare.to}`,
        title: repo.compare.label,
        request: { scope: 'compare', from: repo.compare.from, to: repo.compare.to },
        path: repo.compareDiff?.path,
      }
    }
    if (repo.commitDiff) {
      return {
        key: `commit:${repo.commitDiff.oid}`,
        title: repo.commitDiff.subject,
        request: { scope: 'commit', commit: repo.commitDiff.oid },
        path: repo.commitDiff.path,
      }
    }
    if (repo.selection) {
      return {
        key: repo.selection.scope,
        title: repo.selection.scope === 'staged' ? 'Staged changes' : 'Working tree changes',
        request: { scope: repo.selection.scope },
        path: repo.selection.change.path,
      }
    }
    if (!repo.snapshot) return null
    const scope = repo.snapshot.unstaged.length > 0 || repo.snapshot.staged.length === 0 ? 'unstaged' : 'staged'
    return {
      key: scope,
      title: scope === 'staged' ? 'Staged changes' : 'Working tree changes',
      request: { scope },
    }
  })

  function displayOptions(): CodeViewDisplayOptions {
    return {
      diffStyle: narrow ? 'unified' : reviewPreferences.diffStyle,
      overflow: reviewPreferences.overflow,
      backgrounds: reviewPreferences.backgrounds,
      lineNumbers: reviewPreferences.lineNumbers,
      diffIndicators: reviewPreferences.diffIndicators,
      themeType: reviewPreferences.mode,
      lightThemeName: reviewPreferences.lightThemeName,
      darkThemeName: reviewPreferences.darkThemeName,
    }
  }

  async function load(next: Target, generation: number): Promise<void> {
    const version = ++requestVersion
    loading = true
    error = null
    try {
      const response = await repo.api.review(next.request)
      if (version !== requestVersion) return
      review = response
      controller?.setReview(response)
      fileCount = (response.patch.match(/^diff --git /gm)?.length ?? 0) + response.supplements.length
      collapsed = false
      if (next.path) queueMicrotask(() => controller?.scrollToPath(next.path!))
    } catch (caught) {
      if (version !== requestVersion) return
      error = caught instanceof Error ? caught.message : String(caught)
      review = null
      fileCount = 0
    } finally {
      if (version === requestVersion) loading = false
    }
    void generation
  }

  function toggleCollapse(): void {
    collapsed = !collapsed
    controller?.collapseAll(collapsed)
  }

  onMount(() => {
    if (!host) return
    controller = new ReviewCodeView(host, repo.api, displayOptions())
    if (review) {
      controller.setReview(review)
      fileCount = (review.patch.match(/^diff --git /gm)?.length ?? 0) + review.supplements.length
    }
    const query = matchMedia('(max-width: 767px)')
    const update = () => { narrow = query.matches }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })

  onDestroy(() => controller?.cleanUp())

  $effect(() => {
    const next = target
    const generation = repo.generation
    if (next) void load(next, generation)
  })

  $effect(() => {
    controller?.setDisplay(displayOptions())
  })

  $effect(() => {
    const path = target?.path
    if (path && review) controller?.scrollToPath(path)
  })
</script>

<ThemedSurface class="review-surface">
  <section class="review" aria-label="Review">
    <ReviewHeader
      title={target?.title ?? 'Repository review'}
      {fileCount}
      {collapsed}
      {narrow}
      onToggleCollapse={toggleCollapse}
    />

    <div class="viewer-shell" class:is-loading={loading && review != null}>
      <div class="code-view" bind:this={host}></div>
      {#if loading && review == null}
        <div class="status-layer"><ReviewStatus state="loading" /></div>
      {:else if error}
        <div class="status-layer"><ReviewStatus state="error" {error} onRetry={() => target && load(target, repo.generation)} /></div>
      {:else if review && fileCount === 0}
        <div class="status-layer"><ReviewStatus state="empty" /></div>
      {/if}
    </div>
  </section>
</ThemedSurface>

<style>
  :global(.review-surface) {
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: hidden;
    background: var(--background);
  }
  .review { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; height: 100%; overflow: hidden; }
  .viewer-shell { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--background); }
  .viewer-shell.is-loading::before { position: absolute; z-index: 20; inset: 0 auto auto 0; width: 100%; height: 2px; content: ''; background: var(--color-accent); animation: loading 1.2s ease-in-out infinite; transform-origin: left; }
  .code-view { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto hidden; overscroll-behavior: contain; contain: strict; scrollbar-gutter: stable; }
  .code-view :global(> *) { min-width: 0; }
  .code-view :global(diffs-container) { overflow: clip; contain: layout paint style; box-shadow: 0 -1px 0 var(--diffshub-diff-separator, var(--color-border-opaque)), 0 1px 0 var(--diffshub-diff-separator, var(--color-border-opaque)); }
  .status-layer { position: absolute; z-index: 10; inset: 0; background: var(--background); }
  @keyframes loading { 0% { transform: scaleX(.08); opacity: .4; } 50% { transform: scaleX(.62); opacity: 1; } 100% { transform: translateX(100%) scaleX(.18); opacity: .2; } }
  @media (prefers-reduced-motion: reduce) { .viewer-shell.is-loading::before { animation: none; } }
</style>
