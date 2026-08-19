<script lang="ts">
  import { onDestroy } from 'svelte'
  import { CommitFileTree } from '../lib/pierre-commit-tree'
  import type { CommitRef, CommitFile } from '../lib/types'
  import type { GraphRow } from '../lib/graph-lanes'
  import type { RepoState } from '../lib/repo-state.svelte'
  import Button from './Button.svelte'
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

  let menuOpen = $state(false)
  let resetMode = $state<'soft' | 'mixed' | 'hard'>('mixed')
  let pendingReset = $state<boolean>(false)

  let treeHost: HTMLElement | undefined = $state()
  let commitTree: CommitFileTree | undefined

  function rank(ref: CommitRef): number {
    switch (ref.kind) {
      case 'head': return 0
      case 'local-branch': return 1
      case 'remote-branch': return 2
      case 'tag': return 3
    }
  }

  function handleReset(): void {
    menuOpen = false
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

  $effect(() => {
    if (!treeHost || !expanded) {
      commitTree?.destroy()
      commitTree = undefined
      return
    }
    const tree = new CommitFileTree(treeHost, {
      onSelect: (path) => {
        if (path) {
          const files = repo.commitFiles[row.commit.oid] ?? []
          const file = files.find((f) => f.path === path)
          if (file) repo.selectCommitFile(row.commit.oid, row.commit.subject, file)
        }
      },
    })
    commitTree = tree
    const files = repo.commitFiles[row.commit.oid]
    if (files) tree.update(files)
    return () => {
      tree.destroy()
      commitTree = undefined
    }
  })

  $effect(() => {
    if (!commitTree) return
    const files = repo.commitFiles[row.commit.oid]
    if (files) commitTree.update(files)
  })

  onDestroy(() => {
    commitTree?.destroy()
  })
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
      <div class="tree-container">
        {#if repo.filesError[row.commit.oid]}
          <p class="file-note" role="alert">{repo.filesError[row.commit.oid]}</p>
        {:else if repo.filesLoading[row.commit.oid] && !repo.commitFiles[row.commit.oid]}
          <p class="file-note">Loading…</p>
        {:else if (repo.commitFiles[row.commit.oid] ?? []).length === 0}
          <p class="file-note">No files changed</p>
        {:else}
          <div class="tree-host" bind:this={treeHost}></div>
        {/if}
      </div>
      <div class="row-actions">
        <Button variant="ghost" size="icon-sm" onclick={() => (menuOpen = !menuOpen)} aria-expanded={menuOpen} title="Actions">
          ⋯
        </Button>
        {#if menuOpen}
          <div class="row-menu" role="menu">
            <button class="row-menu-item" role="menuitem" onclick={() => { menuOpen = false; void repo.cherryPick(row.commit.oid) }} disabled={repo.busy}>
              Cherry-pick
            </button>
            <button class="row-menu-item" role="menuitem" onclick={() => { menuOpen = false; void repo.revertCommit(row.commit.oid) }} disabled={repo.busy}>
              Revert
            </button>
            <div class="row-menu-sep"></div>
            <button class="row-menu-item" role="menuitem" onclick={() => { resetMode = 'soft'; handleReset() }} disabled={repo.busy}>
              Reset (soft)
            </button>
            <button class="row-menu-item" role="menuitem" onclick={() => { resetMode = 'mixed'; handleReset() }} disabled={repo.busy}>
              Reset (mixed)
            </button>
            <button class="row-menu-item row-menu-danger" role="menuitem" onclick={() => { resetMode = 'hard'; handleReset() }} disabled={repo.busy}>
              Reset (hard)…
            </button>
          </div>
        {/if}
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
    stroke: var(--muted-foreground);
    stroke-width: 1.2;
    fill: none;
  }

  .lane-node {
    fill: #009fff;
    stroke: var(--background);
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
    border-radius: 4px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }

  .chevron:hover {
    background: var(--accent);
    color: var(--foreground);
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
    font-size: 13px;
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
    font-size: 12px;
    color: var(--muted-foreground);
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
    border-radius: 4px;
    font-size: 11px;
    line-height: 16px;
    white-space: nowrap;
    border: 1px solid var(--border);
    color: var(--muted-foreground);
  }

  .ref-head {
    border-color: #009fff;
    color: #009fff;
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

  .tree-container {
    margin: 4px 0 2px;
  }

  .tree-host {
    min-height: 32px;
    max-height: 200px;
    overflow: auto;
  }

  .tree-host :global([data-file-tree-container]) {
    height: 100%;
  }

  .file-note {
    padding: 4px 8px;
    font-size: 12px;
    color: var(--muted-foreground);
    margin: 0;
  }

  .file-note[role='alert'] {
    color: var(--destructive, #ef4444);
  }

  .row-actions {
    position: relative;
    margin: 2px 0;
  }

  .row-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 20;
    min-width: 140px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--popover, var(--background));
    box-shadow: var(--diffshub-popover-shadow, 0 8px 24px rgb(0 0 0 / 0.25));
  }

  .row-menu-item {
    display: block;
    width: 100%;
    padding: 4px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .row-menu-item:hover:not(:disabled) {
    background: var(--accent);
  }

  .row-menu-item:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .row-menu-danger {
    color: var(--destructive, #ef4444);
  }

  .row-menu-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--border);
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
