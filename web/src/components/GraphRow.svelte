<script lang="ts">
  import type { CommitRef, CommitFile } from '../lib/types'
  import type { GraphRow } from '../lib/graph-lanes'
  import type { RepoState } from '../lib/repo-state.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    row: GraphRow
    repo: RepoState
  }

  let { row, repo }: Props = $props()

  const COLUMN = 22
  const ROW_H = 28
  const NODE_Y = ROW_H / 2
  const NODE_R = 3.5
  const MY = Math.round(NODE_Y * 0.55)

  const width = $derived(row.totalColumns * COLUMN)
  const cx = (col: number): number => col * COLUMN + COLUMN / 2

  const expanded = $derived(!!repo.expanded[row.commit.oid])
  const short = $derived(row.commit.oid.slice(0, 8))

  const date = $derived(
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      new Date(row.commit.authorTime),
    ),
  )

  const sortedRefs = $derived(
    [...row.commit.refs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
  )

  let resetMode = $state<'soft' | 'mixed' | 'hard'>('mixed')
  let pendingReset = $state<boolean>(false)

  function rank(ref: CommitRef): number {
    switch (ref.kind) {
      case 'head':
        return 0
      case 'local-branch':
        return 1
      case 'remote-branch':
        return 2
      case 'tag':
        return 3
    }
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

  function handleReset(): void {
    if (resetMode === 'hard') {
      pendingReset = true
      return
    }
    void repo.resetTo(row.commit.oid, resetMode)
  }

  function confirmHardReset(): void {
    pendingReset = false
    void repo.resetTo(row.commit.oid, 'hard')
  }
</script>

<li class="graph-row" class:expanded>
  <div class="lanes">
    <svg width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`}>
      {#each row.lanes as lane (lane.column)}
        {#if lane.next !== row.commit.oid}
          <line
            x1={cx(lane.column)}
            y1={0}
            x2={cx(lane.column)}
            y2={ROW_H}
            class="lane-line"
          />
        {:else if lane.column === row.column}
          <line x1={cx(lane.column)} y1={0} x2={cx(lane.column)} y2={NODE_Y} class="lane-line" />
        {:else}
          <path
            d={`M ${cx(lane.column)} 0 L ${cx(lane.column)} ${MY} Q ${cx(lane.column)} ${NODE_Y} ${cx(row.column)} ${NODE_Y}`}
            class="lane-line"
          />
        {/if}
      {/each}
      {#each row.outgoing as col (col)}
        <line x1={cx(col)} y1={NODE_Y} x2={cx(col)} y2={ROW_H} class="lane-line" />
      {/each}
      <circle cx={cx(row.column)} cy={NODE_Y} r={NODE_R} class="lane-node" />
    </svg>
  </div>
  <div class="body">
    <div class="line">
      <button
        class="chevron"
        class:open={expanded}
        aria-label={expanded ? 'Collapse commit' : 'Expand commit'}
        onclick={() => void repo.toggleCommit(row.commit.oid)}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" class:open={expanded}>
          <path d="M2 1 L7 4.5 L2 8 Z" />
        </svg>
      </button>
      <span class="subject" title={row.commit.subject}>{row.commit.subject}</span>
    </div>
    <div class="meta">
      {#if sortedRefs.length > 0}
        <span class="refs">
          {#each sortedRefs as ref (ref.kind + ref.name)}
            <span class="ref ref-{ref.kind}" title={ref.name}>{ref.name}</span>
          {/each}
        </span>
      {/if}
      <span class="author">{row.commit.authorName}</span>
      <span class="time">{date}</span>
    </div>
    {#if expanded}
      <ul class="files">
        {#if repo.filesError[row.commit.oid]}
          <li class="file-note" role="alert">{repo.filesError[row.commit.oid]}</li>
        {:else if repo.filesLoading[row.commit.oid] && !repo.commitFiles[row.commit.oid]}
          <li class="file-note">Loading…</li>
        {:else if (repo.commitFiles[row.commit.oid] ?? []).length === 0}
          <li class="file-note">No files changed</li>
        {:else}
          {#each repo.commitFiles[row.commit.oid] ?? [] as file}
            <li>
              <button
                class="file"
                onclick={() => repo.selectCommitFile(row.commit.oid, row.commit.subject, file)}
              >
                <span class="file-kind">{kindGlyph(file.kind)}</span>
                <span class="file-path" title={fileLabel(file)}>{fileLabel(file)}</span>
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      <div class="actions">
        <button
          class="action"
          onclick={() => void repo.cherryPick(row.commit.oid)}
          disabled={repo.busy}
          title="Apply this commit's changes onto the current branch"
        >
          Cherry-pick
        </button>
        <button
          class="action"
          onclick={() => void repo.revertCommit(row.commit.oid)}
          disabled={repo.busy}
          title="Apply the inverse of this commit"
        >
          Revert
        </button>
        <select bind:value={resetMode} class="action-select" aria-label="Reset mode">
          <option value="soft">soft</option>
          <option value="mixed">mixed</option>
          <option value="hard">hard</option>
        </select>
        <button class="action action-danger" onclick={handleReset} disabled={repo.busy} title={`Reset current branch to ${short}`}>
          Reset here
        </button>
      </div>
    {/if}
  </div>
</li>

<style>
  .graph-row {
    display: flex;
    align-items: flex-start;
    min-height: 28px;
  }

  .lanes {
    flex: 0 0 auto;
  }

  .lane-line {
    stroke: var(--color-muted);
    stroke-width: 1.2;
    fill: none;
  }

  .lane-node {
    fill: var(--color-accent);
    stroke: var(--color-bg);
    stroke-width: 1;
  }

  .body {
    flex: 1;
    min-width: 0;
    padding: 3px 8px 3px 0;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .chevron {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
  }

  .chevron:hover {
    background: var(--color-border);
    color: var(--color-fg);
  }

  .chevron svg {
    fill: currentColor;
    transform: rotate(0deg);
    transition: transform 0.12s ease;
  }

  .chevron svg.open {
    transform: rotate(90deg);
  }

  .subject {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-top: 1px;
    font-size: 11px;
    color: var(--color-muted);
  }

  .refs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .ref {
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    line-height: 14px;
    white-space: nowrap;
    border: 1px solid var(--color-border);
    color: var(--color-muted);
  }

  .ref-head {
    border-color: var(--color-accent);
    color: var(--color-accent);
    font-weight: 600;
  }

  .ref-tag {
    border-style: dashed;
  }

  .ref-remote-branch {
    font-style: italic;
  }

  .author {
    white-space: nowrap;
  }

  .time {
    white-space: nowrap;
  }

  .files {
    margin: 4px 0 2px;
    padding: 0;
    list-style: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 8px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-fg);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .file:last-child {
    border-bottom: none;
  }

  .file:hover {
    background: var(--color-selected-bg);
  }

  .file-kind {
    flex: 0 0 auto;
    width: 14px;
    font-size: 10px;
    font-weight: 700;
    color: var(--color-muted);
    text-align: center;
  }

  .file-path {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-note {
    padding: 4px 8px;
    font-size: 11px;
    color: var(--color-muted);
  }

  .file-note[role='alert'] {
    color: var(--color-danger);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 4px 0 2px;
    padding: 3px 6px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    flex-wrap: wrap;
  }

  .action {
    font-size: 10px;
    padding: 1px 6px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
    white-space: nowrap;
  }

  .action-danger {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .action-select {
    font-size: 10px;
    padding: 1px 4px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-fg);
  }
</style>

{#if pendingReset}
  <ConfirmDialog
    title={`Hard reset to ${short}?`}
    message={`Move the current branch to ${row.commit.oid} and discard all tracked working-tree changes. Uncommitted changes will be lost. This cannot be undone.`}
    confirmLabel="Reset hard"
    onConfirm={() => void confirmHardReset()}
    onCancel={() => (pendingReset = false)}
  />
{/if}
