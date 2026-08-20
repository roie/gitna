<!--
  Narrow overlay composition adapted from Pierre DiffsHub DiffsHubSidebar.tsx
  at diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported to Svelte around VS Code Source Control ordering.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { ChangeScope, CommitFile } from '../lib/types'
  import type { WorkbenchActions } from '../lib/workbench-actions'
  import Button from './Button.svelte'
  import ChangesSection from './ChangesSection.svelte'
  import CommitComposer from './CommitComposer.svelte'
  import ConflictView from './ConflictView.svelte'
  import GraphRow from './GraphRow.svelte'
  import OperationBar from './OperationBar.svelte'
  import PierreIcon from './PierreIcon.svelte'

  interface Props {
    state: RepoState
    actions: WorkbenchActions
    onClose?(): void
  }

  let { state: repo, actions, onClose }: Props = $props()

  let root = $state<HTMLElement>()
  let changesHeader = $state<HTMLButtonElement>()
  let graphHeader = $state<HTMLButtonElement>()
  let changesOpen = $state(true)
  let stagedOpen = $state(true)
  let graphOpen = $state(true)
  let changesSearchOpen = $state(false)
  let stagedSearchOpen = $state(false)

  const unstagedCount = $derived(repo.snapshot?.unstaged.length ?? 0)
  const stagedCount = $derived(repo.snapshot?.staged.length ?? 0)
  const graphCount = $derived(repo.graphRows.length)

  function handleSelect(scope: ChangeScope, path: string | null): void {
    if (path) {
      repo.select(scope, path)
      return
    }
    if (repo.selectedChange?.scope === scope) repo.select(scope, null)
  }

  function activateSection(scope: ChangeScope): void {
    const changes = scope === 'staged' ? repo.snapshot?.staged : repo.snapshot?.unstaged
    if (!changes?.length || repo.selection?.scope === scope) return
    repo.select(scope, changes[0]!.path)
  }

  function toggleChanges(): void {
    changesOpen = !changesOpen
    if (changesOpen) activateSection('unstaged')
  }

  function toggleStaged(): void {
    stagedOpen = !stagedOpen
    if (stagedOpen) activateSection('staged')
  }

  function kindGlyph(kind: CommitFile['kind']): string {
    switch (kind) {
      case 'added': return 'A'
      case 'deleted': return 'D'
      case 'renamed': return 'R'
      case 'modified': return 'M'
      default: return '?'
    }
  }

  function fileLabel(file: CommitFile): string {
    return file.kind === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  }

  onMount(() => {
    const mobile = window.matchMedia('(max-width: 767px)')
    if (mobile.matches) graphOpen = false

    const handleFunctionKey = (event: KeyboardEvent): void => {
      if (event.key !== 'F3') return
      event.preventDefault()
      graphOpen = !graphOpen
    }
    window.addEventListener('keydown', handleFunctionKey)

    const unregister = [
      actions.register('focus-changes', () => {
        changesOpen = true
        activateSection('unstaged')
        queueMicrotask(() => changesHeader?.focus())
      }),
      actions.register('focus-graph', () => {
        graphOpen = true
        queueMicrotask(() => graphHeader?.focus())
      }),
      actions.register('refresh', () => {
        void repo.refreshSnapshot()
        void repo.refreshGraph()
      }),
      actions.register('action-menu', () => {
        root?.querySelector<HTMLButtonElement>('[title="More actions"]')?.click()
      }),
    ]
    return () => {
      window.removeEventListener('keydown', handleFunctionKey)
      unregister.forEach((dispose) => dispose())
    }
  })
</script>

<section class="source-control" bind:this={root}>
  <OperationBar {repo} {onClose} />

  <div class="workflow-scroll">
    <CommitComposer state={repo} {actions} />

  <ConflictView state={repo} />

  {#if stagedCount > 0}
    <section class="section">
      <div class="section-heading">
        <button class="section-header" data-section="staged" onclick={toggleStaged} aria-expanded={stagedOpen}>
          <span class="status-icon"><PierreIcon name="symbol-diffstat-fill" size={12} /></span>
          <span class="section-title">Staged Changes</span>
          <span class="section-count">{stagedCount}</span>
        </button>
        {#if stagedOpen}
          <button
            class="section-search"
            class:active={stagedSearchOpen}
            aria-label="Search Staged Changes"
            aria-pressed={stagedSearchOpen}
            onclick={() => (stagedSearchOpen = !stagedSearchOpen)}
          ><PierreIcon name="search" size={12} /></button>
        {/if}
      </div>
      {#if stagedOpen}
        <ChangesSection
          scope="staged"
          changes={repo.snapshot?.staged ?? []}
          selection={repo.selection}
          searchOpen={stagedSearchOpen}
          onSelect={handleSelect}
        />
      {/if}
    </section>
  {/if}

  <section class="section">
    <div class="section-heading">
      <button
        class="section-header"
        data-section="changes"
        bind:this={changesHeader}
        onclick={toggleChanges}
        aria-expanded={changesOpen}
      >
        <span class="status-icon"><PierreIcon name={changesOpen ? 'file-tree-fill' : 'file-tree'} size={12} /></span>
        <span class="section-title">Changes</span>
        <span class="section-count">{unstagedCount}</span>
      </button>
      {#if changesOpen && unstagedCount > 0}
        <button
          class="section-search"
          class:active={changesSearchOpen}
          aria-label="Search Changes"
          aria-pressed={changesSearchOpen}
          onclick={() => (changesSearchOpen = !changesSearchOpen)}
        ><PierreIcon name="search" size={12} /></button>
      {/if}
    </div>
    {#if changesOpen && unstagedCount > 0}
      <ChangesSection
        scope="unstaged"
        changes={repo.snapshot?.unstaged ?? []}
        selection={repo.selection}
        searchOpen={changesSearchOpen}
        onSelect={handleSelect}
      />
    {:else if changesOpen}
      <p class="section-note">No changes</p>
    {/if}
  </section>
  </div>

  <section class="section graph-section" class:open={graphOpen}>
    <button class="section-header" data-section="graph" bind:this={graphHeader} onclick={() => (graphOpen = !graphOpen)} aria-expanded={graphOpen}>
      <span class="status-icon"><PierreIcon name="line-graph" size={12} /></span>
      <span class="section-title">Graph</span>
      <span class="section-shortcut">(F3)</span>
      <span class="section-count">{graphCount}</span>
    </button>
    {#if graphOpen}
      {#if repo.compare}
        <div class="compare-result">
          <span class="compare-title" title={repo.compare.label}>{repo.compare.label}</span>
          <Button variant="ghost" size="icon-sm" onclick={() => repo.clearCompare()} aria-label="Close compare">×</Button>
          {#if repo.compareError}
            <p class="section-note" role="alert">{repo.compareError}</p>
          {:else if repo.compareLoading}
            <p class="section-note">Loading…</p>
          {:else if repo.compareFiles.length === 0}
            <p class="section-note">No differences</p>
          {:else}
            <ul class="compare-files">
              {#each repo.compareFiles as file (file.path)}
                <li>
                  <button class="compare-file" onclick={() => repo.selectCompareFile(file)}>
                    <span class="compare-kind">{kindGlyph(file.kind)}</span>
                    <span class="compare-path" title={fileLabel(file)}>{fileLabel(file)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      {#if repo.graphRows.length === 0}
        <p class="section-note" class:alert={!!repo.graphError} role={repo.graphError ? 'alert' : undefined}>
          {repo.graphError ?? (repo.graphLoading ? 'Loading graph…' : 'No commits yet')}
        </p>
      {:else}
        <ul class="graph-list">
          {#each repo.graphRows as row (row.commit.oid)}
            <GraphRow {row} repo={repo} />
          {/each}
        </ul>
        {#if repo.graphHasMore}
          <Button variant="outline" size="sm" onclick={() => void repo.loadMoreGraph()} disabled={repo.graphLoading}>
            Load more
          </Button>
        {/if}
      {/if}
    {/if}
  </section>

  {#if repo.error}
    <p class="error" role="alert">{repo.error}</p>
  {/if}
</section>

<style>
  .source-control {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    height: 100%;
    border-right: 1px solid var(--color-border-opaque, var(--border));
    background: var(--diffshub-sidebar-bg, var(--background));
    color: var(--foreground);
    overflow: hidden;
    contain: strict;
  }

  .workflow-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-color: color-mix(in srgb, var(--foreground) 22%, transparent) transparent;
    scrollbar-width: thin;
  }

  .section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .section-heading {
    display: flex;
    align-items: center;
    min-height: 33px;
    margin: 0 12px;
    border-top: 1px solid var(--color-border-opaque, var(--border));
  }

  .section-header {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 32px;
    padding: 8px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-family: inherit;
    font-size: 14px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .section-header:hover,
  .section-header:focus-visible {
    background: transparent;
    color: var(--foreground);
    outline: none;
  }

  .status-icon {
    display: inline-grid;
    flex: 0 0 12px;
    width: 12px;
    place-items: center;
    opacity: 0.5;
  }

  .section-title {
    flex: 1;
    font-weight: 400;
  }

  .section-shortcut {
    color: color-mix(in srgb, var(--muted-foreground) 50%, transparent);
  }

  .section-count {
    font-variant-numeric: tabular-nums;
    font-weight: 400;
  }

  .section-search {
    display: grid;
    width: 20px;
    height: 20px;
    margin-right: 8px;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }

  .section-search:hover,
  .section-search:focus-visible,
  .section-search.active {
    background: transparent;
    color: var(--foreground);
    outline: none;
  }

  .graph-section {
    display: flex;
    flex: 0 0 33px;
    flex-direction: column;
    min-height: 0;
    max-height: 33px;
    overflow: hidden;
    border-bottom: 1px solid var(--color-border-opaque, var(--border));
  }

  .graph-section.open {
    flex: 0 1 46%;
    max-height: 46%;
  }

  .graph-section > .section-header {
    flex: 0 0 auto;
    width: calc(100% - 24px);
    margin: 0 12px;
    border-top: 1px solid var(--color-border-opaque, var(--border));
  }

  .graph-list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 6px 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }

  .compare-result {
    padding: 0 8px 4px;
    border-bottom: 1px solid var(--border);
  }

  .compare-title {
    display: inline-block;
    max-width: calc(100% - 24px);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .compare-files {
    margin: 0;
    padding: 0 0 4px;
    list-style: none;
  }

  .compare-file {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 2px 0;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 12px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }

  .compare-file:hover {
    background: var(--accent);
  }

  .compare-kind {
    flex: 0 0 auto;
    width: 14px;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted-foreground);
    text-align: center;
  }

  .compare-path {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .section-note {
    padding: 4px 8px;
    font-size: 12px;
    color: var(--muted-foreground);
    margin: 0;
  }

  .section-note[role='alert'] {
    color: var(--destructive, #ef4444);
  }

  .error {
    margin: 8px 12px;
    font-size: 12px;
    color: var(--destructive, #ef4444);
  }

  @media (width <= 767px) {
    .source-control {
      border-right: 0;
      border-radius: 14px 14px 0 0;
    }
  }
</style>
