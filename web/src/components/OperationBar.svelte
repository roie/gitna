<script lang="ts">
  import { ApiError } from '../lib/api'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { Branch } from '../lib/types'
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    repo: RepoState
  }

  let { repo }: Props = $props()

  let menuOpen = $state(false)
  let newBranchName = $state('')
  let actionError = $state<string | null>(null)
  let pendingDelete = $state<string | null>(null)
  let publishBranch = $state<string | null>(null)
  let publishRemote = $state('origin')

  const localBranches = $derived((repo.branches ?? []).filter((b) => !b.remote))
  const remoteBranches = $derived((repo.branches ?? []).filter((b) => b.remote))
  const remotes = $derived.by(() => {
    const names = new Set<string>()
    for (const b of remoteBranches) {
      const slash = b.name.indexOf('/')
      if (slash > 0) names.add(b.name.slice(0, slash))
    }
    return [...names].sort()
  })

  const upstreamLabel = $derived.by(() => {
    const snap = repo.snapshot
    if (!snap?.upstream) return 'no upstream'
    const bits = []
    if (snap.ahead > 0) bits.push(`↑${snap.ahead}`)
    if (snap.behind > 0) bits.push(`↓${snap.behind}`)
    return bits.length ? `${snap.upstream} ${bits.join(' ')}` : snap.upstream
  })

  async function run(action: () => Promise<void>): Promise<void> {
    actionError = null
    try {
      await action()
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e)
    }
  }

  function handleFetch(): void {
    void run(() => repo.fetchRemote())
  }

  function handlePull(): void {
    void run(() => repo.pullRemote())
  }

  function handlePush(): void {
    publishBranch = null
    void run(async () => {
      try {
        await repo.pushRemote()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'no-upstream') {
          publishBranch = e.branch ?? repo.snapshot?.headBranch ?? null
          if (remotes[0]) publishRemote = remotes[0]
          return
        }
        throw e
      }
    })
  }

  function handleCreate(event: SubmitEvent): void {
    event.preventDefault()
    const name = newBranchName.trim()
    if (!name || repo.busy) return
    newBranchName = ''
    void run(() => repo.createBranch(name))
  }

  function handleSwitch(branch: Branch): void {
    if (branch.current) return
    menuOpen = false
    void run(() => repo.switchBranch(branch.name))
  }

  function handleDelete(branch: Branch): void {
    void run(async () => {
      try {
        await repo.deleteBranch(branch.name)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'branch-not-merged') {
          pendingDelete = branch.name
          return
        }
        throw e
      }
    })
  }

  async function confirmForceDelete(): Promise<void> {
    const name = pendingDelete
    pendingDelete = null
    if (!name) return
    await run(() => repo.deleteBranch(name, true))
  }

  function handlePublish(): void {
    const branch = publishBranch
    if (!branch) return
    void run(async () => {
      await repo.pushSetUpstream(publishRemote || 'origin', branch)
      publishBranch = null
    })
  }
</script>

{#if repo.snapshot}
  <div class="operation-bar">
    <div class="sync-row">
      <span class="sync-label" title="upstream">{upstreamLabel}</span>
      <button class="action" onclick={handleFetch} disabled={repo.busy}>Fetch</button>
      <button class="action" onclick={handlePull} disabled={repo.busy}>Pull</button>
      <button class="action" onclick={handlePush} disabled={repo.busy}>Push</button>
    </div>

    <div class="branch-row">
      <button
        class="action branch-toggle"
        onclick={() => {
          menuOpen = !menuOpen
          if (menuOpen) void repo.refreshBranches()
        }}
        aria-expanded={menuOpen}
        aria-label="Branches"
      >
        Branches {menuOpen ? '▴' : '▾'}
      </button>
      {#if menuOpen}
        <div class="branch-menu" role="menu">
          <form class="create-form" onsubmit={handleCreate}>
            <input
              bind:value={newBranchName}
              placeholder="New branch name"
              aria-label="New branch name"
              spellcheck="false"
            />
            <button class="action" type="submit" disabled={repo.busy || !newBranchName.trim()}>New</button>
          </form>
          <ul class="branch-list">
            {#each localBranches as branch (branch.name)}
              <li class="branch-item">
                <button
                  class="branch-name"
                  class:current={branch.current}
                  onclick={() => handleSwitch(branch)}
                  disabled={branch.current || repo.busy}
                  title={branch.current ? 'current branch' : `switch to ${branch.name}`}
                >
                  <span class="branch-marker">{branch.current ? '●' : ''}</span>
                  <span class="branch-name-label">{branch.name}</span>
                  {#if branch.upstream}
                    <span class="branch-track"
                      >{branch.upstream}{branch.ahead > 0 ? ` ↑${branch.ahead}` : ''}{branch.behind > 0 ? ` ↓${branch.behind}` : ''}</span
                    >
                  {/if}
                </button>
                {#if !branch.current}
                  <button
                    class="branch-delete"
                    onclick={() => handleDelete(branch)}
                    disabled={repo.busy}
                    aria-label={`delete ${branch.name}`}
                    title="Delete branch"
                  >
                    ×
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
          {#if remoteBranches.length}
            <ul class="branch-list remote">
              {#each remoteBranches as branch (branch.name)}
                <li class="branch-item" title={branch.name}>
                  <span class="branch-marker"></span>
                  <span class="branch-name-label">{branch.name}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>

    {#if publishBranch}
      <div class="publish-row" role="status">
        <span class="publish-message"
          >Branch <b>{publishBranch}</b> has no upstream — publish to:</span
        >
        {#if remotes.length}
          <select bind:value={publishRemote} class="publish-remote">
            {#each remotes as remote}
              <option value={remote}>{remote}</option>
            {/each}
          </select>
        {:else}
          <span class="publish-remote-empty">origin</span>
        {/if}
        <button class="action" onclick={handlePublish} disabled={repo.busy}>Publish</button>
      </div>
    {/if}

    {#if actionError}
      <p class="error" role="alert">{actionError}</p>
    {/if}
  </div>
{/if}

{#if pendingDelete}
  <ConfirmDialog
    title={`Delete branch ${pendingDelete}?`}
    message="The branch is not fully merged. Deleting it discards the commits only reachable from it."
    confirmLabel="Delete anyway"
    onConfirm={() => void confirmForceDelete()}
    onCancel={() => (pendingDelete = null)}
  />
{/if}

<style>
  .operation-bar {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.4rem 0.75rem 0.55rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 12px;
  }

  .sync-row,
  .branch-row,
  .publish-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .sync-label {
    flex: 1;
    min-width: 0;
    color: var(--color-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .action {
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .branch-row {
    position: relative;
  }

  .branch-toggle {
    width: 100%;
  }

  .branch-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 20;
    padding: 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
    max-height: 320px;
    overflow-y: auto;
  }

  .create-form {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }

  .create-form input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 11px;
  }

  .branch-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .branch-list.remote {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--color-border);
  }

  .branch-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .branch-item + .branch-item {
    margin-top: 2px;
  }

  .branch-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 2px 4px;
    border: none;
    background: transparent;
    color: var(--color-fg);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
  }

  .branch-name:hover:not(:disabled) {
    background: var(--color-selected-bg);
  }

  .branch-name:disabled {
    cursor: default;
  }

  .branch-name.current .branch-name-label {
    font-weight: 600;
  }

  .branch-marker {
    width: 0.6rem;
    color: var(--color-accent);
    text-align: center;
  }

  .branch-name-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .branch-track {
    color: var(--color-muted);
    white-space: nowrap;
  }

  .branch-list.remote {
    color: var(--color-muted);
  }

  .branch-delete {
    padding: 0 6px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    font-size: 13px;
    cursor: pointer;
    line-height: 1.2;
    border-radius: 4px;
  }

  .branch-delete:hover:not(:disabled) {
    color: var(--color-danger);
  }

  .branch-delete:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .publish-row {
    flex-wrap: wrap;
  }

  .publish-message {
    color: var(--color-muted);
  }

  .publish-remote {
    padding: 2px 4px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 11px;
  }

  .publish-remote-empty {
    color: var(--color-muted);
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    word-break: break-word;
  }
</style>
