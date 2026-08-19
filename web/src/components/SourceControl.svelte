<script lang="ts">
import type { RepoState } from '../lib/repo-state.svelte'
import type { ChangeScope, CommitFile } from '../lib/types'
import Button from './Button.svelte'
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
    display: flex;
    flex-direction: column;
    width: 360px;
    min-width: 240px;
    height: 100%;
    border-right: 1px solid var(--border);
    background: var(--background);
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
    padding: 4px 8px;
    border: none;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }

  .section-header:hover {
    background: var(--accent);
    color: var(--foreground);
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
    margin: 8px;
    font-size: 12px;
    color: var(--destructive, #ef4444);
  }
</style>
