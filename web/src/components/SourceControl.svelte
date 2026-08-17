<script lang="ts">
import type { RepoState } from '../lib/repo-state.svelte'
import type { ChangeScope, CommitFile } from '../lib/types'
import ChangesSection from './ChangesSection.svelte'
import CommitComposer from './CommitComposer.svelte'
import ConflictView from './ConflictView.svelte'
import GraphRow from './GraphRow.svelte'
import OperationBar from './OperationBar.svelte'

  interface Props {
    state: RepoState
  }

  let { state: repo }: Props = $props()

  let changesOpen = $state(true)
  let stagedOpen = $state(true)
  let graphOpen = $state(true)

  const unstagedCount = $derived(repo.snapshot?.unstaged.length ?? 0)
  const stagedCount = $derived(repo.snapshot?.staged.length ?? 0)
  const graphCount = $derived(repo.graphRows.length)

  $effect(() => {
    if (unstagedCount === 0) changesOpen = false
  })
  $effect(() => {
    if (stagedCount === 0) stagedOpen = false
  })

  function handleSelect(scope: ChangeScope, path: string | null): void {
    if (path) {
      repo.select(scope, path)
      return
    }
    if (repo.selectedChange?.scope === scope) repo.select(scope, null)
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
</script>

<section class="source-control">
  <OperationBar {repo} />

  <ConflictView state={repo} />

  <CommitComposer state={repo} />

  <section class="section">
    <button class="section-header" onclick={() => (changesOpen = !changesOpen)} aria-expanded={changesOpen}>
      <span class="section-chevron">{changesOpen ? '▾' : '▸'}</span>
      <span class="section-title">Changes</span>
      <span class="section-count">{unstagedCount}</span>
    </button>
    {#if changesOpen}
      <ChangesSection
        scope="unstaged"
        changes={repo.snapshot?.unstaged ?? []}
        selection={repo.selection}
        onSelect={handleSelect}
      />
    {/if}
  </section>

  <section class="section">
    <button class="section-header" onclick={() => (stagedOpen = !stagedOpen)} aria-expanded={stagedOpen}>
      <span class="section-chevron">{stagedOpen ? '▾' : '▸'}</span>
      <span class="section-title">Staged Changes</span>
      <span class="section-count">{stagedCount}</span>
    </button>
    {#if stagedOpen}
      <ChangesSection
        scope="staged"
        changes={repo.snapshot?.staged ?? []}
        selection={repo.selection}
        onSelect={handleSelect}
      />
    {/if}
  </section>

  <section class="section graph-section">
    <button class="section-header" onclick={() => (graphOpen = !graphOpen)} aria-expanded={graphOpen}>
      <span class="section-chevron">{graphOpen ? '▾' : '▸'}</span>
      <span class="section-title">Graph</span>
      <span class="section-count">{graphCount}</span>
    </button>
    {#if graphOpen}
      {#if repo.compare}
        <div class="compare-result">
          <span class="compare-title" title={repo.compare.label}>{repo.compare.label}</span>
          <button class="compare-close" onclick={() => repo.clearCompare()} aria-label="Close compare">×</button>
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
          <button class="load-more" onclick={() => void repo.loadMoreGraph()} disabled={repo.graphLoading}>
            Load more
          </button>
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
    display: flex;
    flex-direction: column;
    width: 360px;
    min-width: 240px;
    height: 100%;
    border-right: 1px solid var(--color-border);
    background: var(--color-bg);
    overflow-y: auto;
  }

  .section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: none;
    border-top: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    text-align: left;
  }

  .section-header:hover {
    background: var(--color-selected-bg);
    color: var(--color-fg);
  }

  .section-chevron {
    flex: 0 0 auto;
    font-size: 10px;
    width: 12px;
    text-align: center;
  }

  .section-title {
    flex: 1;
  }

  .section-count {
    font-weight: 400;
  }

  .graph-section {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .graph-section .section-header {
    flex: 0 0 auto;
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
    flex: 0 0 auto;
  }

  .load-more:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .compare-result {
    padding: 0 0.75rem 0.35rem;
    border-bottom: 1px solid var(--color-border);
  }

  .compare-title {
    display: inline-block;
    max-width: calc(100% - 24px);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .compare-close {
    float: right;
    padding: 0 4px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    font-size: 14px;
    cursor: pointer;
  }

  .compare-close:hover {
    color: var(--color-danger);
  }

  .compare-files {
    margin: 0;
    padding: 0 0 0.35rem;
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

  .section-note {
    padding: 0.35rem 0.75rem;
    font-size: 11px;
    color: var(--color-muted);
    margin: 0;
  }

  .section-note[role='alert'] {
    color: var(--color-danger);
  }

  .error {
    margin: 0.5rem 0.75rem;
    font-size: 12px;
    color: var(--color-danger);
  }
</style>
