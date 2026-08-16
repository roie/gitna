<script lang="ts">
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { CommitFile } from '../lib/types'
  import GraphRow from './GraphRow.svelte'

  interface Props {
    state: RepoState
  }

  let { state: repo }: Props = $props()

  let compareOpen = $state(false)
  let compareFrom = $state('HEAD')
  let compareTo = $state('HEAD')

  const refOptions = $derived.by(() => {
    const options: Array<{ value: string; label: string }> = [{ value: 'HEAD', label: 'HEAD' }]
    for (const branch of repo.branches ?? []) {
      options.push({ value: branch.name, label: `${branch.name}${branch.remote ? ' (remote)' : ''}` })
    }
    for (const tag of repo.tags ?? []) {
      options.push({ value: tag.name, label: `tag: ${tag.name}` })
    }
    return options
  })

  function toggleCompare(): void {
    compareOpen = !compareOpen
    if (compareOpen) {
      void repo.refreshBranches()
      void repo.refreshTags()
    }
  }

  function handleCompare(): void {
    if (compareFrom === compareTo) return
    void repo.openCompare(compareFrom, compareTo, `${compareFrom}..${compareTo}`)
  }

  function kindGlyph(kind: CommitFile['kind']): string {
    switch (kind) {
      case 'added':
        return 'A'
      case 'deleted':
        return 'D'
      case 'renamed':
        return 'R'
      case 'modified':
        return 'M'
      default:
        return '?'
    }
  }

  function fileLabel(file: CommitFile): string {
    return file.kind === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  }
</script>

<section class="graph-section" aria-label="Graph">
  <header class="graph-header">
    <span class="title">Graph</span>
    <button class="compare-toggle" onclick={toggleCompare} aria-expanded={compareOpen}>
      {compareOpen ? 'Hide compare' : 'Compare'}
    </button>
    <button
      class="refresh"
      onclick={() => void repo.refreshGraph()}
      disabled={repo.graphLoading}
      aria-label="Refresh graph"
    >
      Refresh
    </button>
  </header>
  {#if compareOpen}
    <div class="compare-bar">
      <select bind:value={compareFrom} class="compare-select" aria-label="Compare from">
        {#each refOptions as option (option.value + option.label)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      <span class="compare-sep">…</span>
      <select bind:value={compareTo} class="compare-select" aria-label="Compare to">
        {#each refOptions as option (option.value + option.label)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      <button class="compare-run" onclick={handleCompare} disabled={repo.busy || compareFrom === compareTo}>
        Compare
      </button>
    </div>
    {#if repo.compare}
      <div class="compare-result">
        <span class="compare-title" title={repo.compare.label}>{repo.compare.label}</span>
        <button class="compare-close" onclick={() => repo.clearCompare()} aria-label="Close compare">
          ×
        </button>
        {#if repo.compareError}
          <p class="compare-note" role="alert">{repo.compareError}</p>
        {:else if repo.compareLoading}
          <p class="compare-note">Loading…</p>
        {:else if repo.compareFiles.length === 0}
          <p class="compare-note">No differences</p>
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
  {/if}
  {#if repo.graphRows.length === 0}
    <p class="graph-message" class:alert={!!repo.graphError} role={repo.graphError ? 'alert' : undefined}>
      {repo.graphError ?? (repo.graphLoading ? 'Loading graph…' : 'No commits yet')}
    </p>
  {:else}
    <ul class="graph-list">
      {#each repo.graphRows as row (row.commit.oid)}
        <GraphRow {row} repo={repo} />
      {/each}
    </ul>
    {#if repo.graphHasMore}
      <button class="load-more" onclick={() => void repo.loadMoreGraph()} disabled={repo.graphLoading}>
        Load more
      </button>
    {/if}
  {/if}
</section>

<style>
  .graph-section {
    display: flex;
    flex-direction: column;
    width: 300px;
    min-width: 240px;
    height: 100%;
    border-right: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .graph-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
  }

  .refresh {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .compare-toggle {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .compare-toggle[aria-expanded='true'] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .refresh:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .compare-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .compare-select {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 11px;
  }

  .compare-sep {
    color: var(--color-muted);
  }

  .compare-run {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
    white-space: nowrap;
  }

  .compare-run:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .compare-result {
    border-bottom: 1px solid var(--color-border);
  }

  .compare-title {
    display: inline-block;
    max-width: calc(100% - 24px);
    padding: 0.35rem 0.75rem;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .compare-close {
    float: right;
    padding: 0 8px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    font-size: 14px;
    cursor: pointer;
  }

  .compare-close:hover {
    color: var(--color-danger);
  }

  .compare-note {
    margin: 0.4rem 0.75rem;
    font-size: 11px;
    color: var(--color-muted);
  }

  .compare-note[role='alert'] {
    color: var(--color-danger);
  }

  .compare-files {
    margin: 0;
    padding: 0 0 0.4rem;
    list-style: none;
  }

  .compare-file {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 0.75rem;
    border: none;
    background: transparent;
    color: var(--color-fg);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .compare-file:hover {
    background: var(--color-selected-bg);
  }

  .compare-kind {
    flex: 0 0 auto;
    width: 14px;
    font-size: 10px;
    font-weight: 700;
    color: var(--color-muted);
    text-align: center;
  }

  .compare-path {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .graph-message {
    margin: 1rem 0.75rem;
    font-size: 12px;
    color: var(--color-muted);
  }

  .graph-message[role='alert'] {
    color: var(--color-danger);
  }

  .graph-list {
    flex: 1;
    margin: 0;
    padding: 4px 0;
    list-style: none;
    overflow-y: auto;
  }

  .load-more {
    margin: 0.5rem 0.75rem;
    font-size: 11px;
    padding: 3px 10px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
  }

  .load-more:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
