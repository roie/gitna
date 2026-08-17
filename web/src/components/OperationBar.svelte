<script lang="ts">
  import { ApiError } from '../lib/api'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { Branch } from '../lib/types'
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    repo: RepoState
  }

  let { repo }: Props = $props()

  let branchOpen = $state(false)
  let overflowOpen = $state(false)
  let newBranchName = $state('')
  let actionError = $state<string | null>(null)
  let pendingDelete = $state<string | null>(null)
  let publishBranch = $state<string | null>(null)
  let publishRemote = $state('origin')

  let stashOpen = $state(false)
  let stashMessage = $state('')
  let stashUntracked = $state(false)

  let tagsOpen = $state(false)
  let newTagName = $state('')
  let newTagMessage = $state('')
  let tagTarget = $state('HEAD')
  let tagPushRemote = $state('origin')

  let compareOpen = $state(false)
  let compareFrom = $state('HEAD')
  let compareTo = $state('HEAD')

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

  const tagTargets = $derived.by(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: 'HEAD', label: 'HEAD' }]
    for (const b of localBranches) opts.push({ value: b.name, label: b.name })
    for (const b of remoteBranches) opts.push({ value: b.name, label: `${b.name} (remote)` })
    return opts
  })

  const compareRefOptions = $derived.by(() => {
    const options: Array<{ value: string; label: string }> = [{ value: 'HEAD', label: 'HEAD' }]
    for (const branch of repo.branches ?? []) {
      options.push({ value: branch.name, label: `${branch.name}${branch.remote ? ' (remote)' : ''}` })
    }
    for (const tag of repo.tags ?? []) {
      options.push({ value: tag.name, label: `tag: ${tag.name}` })
    }
    return options
  })

  function toggleBranch(): void {
    branchOpen = !branchOpen
    overflowOpen = false
    if (branchOpen) void repo.refreshBranches()
  }

  function toggleOverflow(): void {
    overflowOpen = !overflowOpen
    branchOpen = false
    if (overflowOpen) {
      void repo.refreshBranches()
      void repo.refreshStashes()
      void repo.refreshTags()
    }
  }

  function closeAll(): void {
    branchOpen = false
    overflowOpen = false
    stashOpen = false
    tagsOpen = false
    compareOpen = false
  }

  function toggleStash(): void {
    stashOpen = !stashOpen
  }

  function toggleTags(): void {
    tagsOpen = !tagsOpen
  }

  function toggleCompare(): void {
    compareOpen = !compareOpen
    if (compareOpen) {
      void repo.refreshBranches()
      void repo.refreshTags()
    }
  }

  function handleStashPush(event: SubmitEvent): void {
    event.preventDefault()
    const message = stashMessage.trim()
    if (!message || repo.busy) return
    stashMessage = ''
    void run(() => repo.stashPush(message, stashUntracked))
  }

  function handleStashApply(ref: string): void {
    void run(() => repo.stashApply(ref))
  }

  function handleStashPop(ref: string): void {
    void run(() => repo.stashPop(ref))
  }

  function handleStashDrop(ref: string): void {
    void run(() => repo.stashDrop(ref))
  }

  function handleCreateTag(event: SubmitEvent): void {
    event.preventDefault()
    const name = newTagName.trim()
    if (!name || repo.busy) return
    const target = tagTarget === 'HEAD' ? undefined : tagTarget
    const message = newTagMessage.trim()
    newTagName = ''
    newTagMessage = ''
    void run(() => repo.createTag(name, target, message))
  }

  function handleDeleteTag(name: string): void {
    void run(() => repo.deleteTag(name))
  }

  function handlePushTag(name: string): void {
    const remote = tagPushRemote || remotes[0] || 'origin'
    void run(() => repo.pushTag(remote, name))
  }

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
    branchOpen = false
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

  function handleCompare(): void {
    if (compareFrom === compareTo) return
    void repo.openCompare(compareFrom, compareTo, `${compareFrom}..${compareTo}`)
  }
</script>

{#if repo.snapshot}
  <div class="toolbar">
    <button class="branch-button" onclick={toggleBranch} aria-expanded={branchOpen}>
      <span class="branch-name">{repo.snapshot?.headBranch ?? repo.snapshot?.headOid?.slice(0, 8) ?? '—'}</span>
      <span class="branch-chevron">{branchOpen ? '▴' : '▾'}</span>
    </button>
    <span class="toolbar-spacer"></span>
    {#if repo.activeOpLabel}
      <span class="active-op" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span class="active-op-text">{repo.activeOpLabel}</span>
      </span>
    {/if}
    <button class="icon-button" onclick={handleFetch} disabled={repo.busy} title="Fetch">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.75.75 0 0 1 .75.75v5.59l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V1.75A.75.75 0 0 1 8 1ZM2.5 12a.75.75 0 0 1 .75.75v1.5A1.75 1.75 0 0 0 5 16h6a1.75 1.75 0 0 0 1.75-1.75v-1.5a.75.75 0 0 1 1.5 0v1.5A3.25 3.25 0 0 1 11.25 18.5h-6.5A3.25 3.25 0 0 1 1.5 15.25v-1.5A.75.75 0 0 1 2.5 12Z"/></svg>
    </button>
    <button class="icon-button" onclick={handlePull} disabled={repo.busy} title="Pull">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75 1.75a.75.75 0 0 0-1.5 0V5H4.75a.75.75 0 0 0 0 1.5h3.5V5a.75.75 0 0 1 1.5 0v3h2.25a.75.75 0 0 0 0-1.5H8.75V1.75ZM2.5 12a.75.75 0 0 1 .75.75v1.5A1.75 1.75 0 0 0 5 16h6a1.75 1.75 0 0 0 1.75-1.75v-1.5a.75.75 0 0 1 1.5 0v1.5A3.25 3.25 0 0 1 11.25 18.5h-6.5A3.25 3.25 0 0 1 1.5 15.25v-1.5A.75.75 0 0 1 2.5 12Z"/></svg>
    </button>
    <button class="icon-button" onclick={handlePush} disabled={repo.busy} title="Push">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.47 5.28a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1-1.06 1.06L8.75 7.51v5.74a.75.75 0 0 1-1.5 0V7.51L5.53 9.34a.75.75 0 0 1-1.06-1.06l3-3ZM2.5 12a.75.75 0 0 1 .75.75v1.5A1.75 1.75 0 0 0 5 16h6a1.75 1.75 0 0 0 1.75-1.75v-1.5a.75.75 0 0 1 1.5 0v1.5A3.25 3.25 0 0 1 11.25 18.5h-6.5A3.25 3.25 0 0 1 1.5 15.25v-1.5A.75.75 0 0 1 2.5 12Z"/></svg>
    </button>
    <button class="icon-button overflow-toggle" onclick={toggleOverflow} aria-expanded={overflowOpen} title="More actions">
      ⋯
    </button>
  </div>

  {#if branchOpen}
    <div class="dropdown branch-dropdown">
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

  {#if overflowOpen}
    <div class="dropdown overflow-dropdown">
      <button class="overflow-item" onclick={() => { void repo.refreshGraph(); overflowOpen = false }}>
        Refresh Graph
      </button>

      <button class="overflow-item" onclick={toggleCompare} aria-expanded={compareOpen}>
        Compare refs {compareOpen ? '▴' : '▾'}
      </button>
      {#if compareOpen}
        <div class="compare-panel">
          <select bind:value={compareFrom} class="compare-select" aria-label="Compare from">
            {#each compareRefOptions as option (option.value + option.label)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <span class="compare-sep">..</span>
          <select bind:value={compareTo} class="compare-select" aria-label="Compare to">
            {#each compareRefOptions as option (option.value + option.label)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <button class="action" onclick={handleCompare} disabled={repo.busy || compareFrom === compareTo}>
            Compare
          </button>
        </div>
        {#if repo.compare}
          <div class="compare-result">
            <span class="compare-title" title={repo.compare.label}>{repo.compare.label}</span>
            <button class="compare-close" onclick={() => repo.clearCompare()} aria-label="Close compare">×</button>
            {#if repo.compareError}
              <p class="overflow-error" role="alert">{repo.compareError}</p>
            {:else if repo.compareLoading}
              <p class="overflow-note">Loading…</p>
            {:else if repo.compareFiles.length === 0}
              <p class="overflow-note">No differences</p>
            {/if}
          </div>
        {/if}
      {/if}

      <button class="overflow-item" onclick={toggleStash} aria-expanded={stashOpen}>
        Stash {stashOpen ? '▴' : '▾'}
      </button>
      {#if stashOpen}
        <div class="overflow-panel">
          <form class="create-form" onsubmit={handleStashPush}>
            <input
              bind:value={stashMessage}
              placeholder="Stash message"
              aria-label="Stash message"
              spellcheck="false"
            />
            <label class="check-label" title="Include untracked files">
              <input type="checkbox" bind:checked={stashUntracked} aria-label="Include untracked" />
              untracked
            </label>
            <button class="action" type="submit" disabled={repo.busy || !stashMessage.trim()}>
              Stash
            </button>
          </form>
          <ul class="item-list">
            {#each repo.stashes ?? [] as entry (entry.ref)}
              <li class="item-row" title={`${entry.branch}: ${entry.message}`}>
                <span class="item-label">
                  <b>{entry.ref}</b> {entry.branch}: {entry.message}
                </span>
                <button class="item-action" onclick={() => handleStashApply(entry.ref)} disabled={repo.busy} title="Apply without removing">Apply</button>
                <button class="item-action" onclick={() => handleStashPop(entry.ref)} disabled={repo.busy} title="Apply and remove">Pop</button>
                <button class="item-action" onclick={() => handleStashDrop(entry.ref)} disabled={repo.busy} title="Drop stash">×</button>
              </li>
            {:else}
              <li class="overflow-note">No stashes</li>
            {/each}
          </ul>
        </div>
      {/if}

      <button class="overflow-item" onclick={toggleTags} aria-expanded={tagsOpen}>
        Tags {tagsOpen ? '▴' : '▾'}
      </button>
      {#if tagsOpen}
        <div class="overflow-panel">
          <form class="create-form" onsubmit={handleCreateTag}>
            <input
              bind:value={newTagName}
              placeholder="Tag name"
              aria-label="New tag name"
              spellcheck="false"
            />
            <select bind:value={tagTarget} class="compare-select" aria-label="Tag target">
              {#each tagTargets as target (target.value + target.label)}
                <option value={target.value}>{target.label}</option>
              {/each}
            </select>
            <input
              bind:value={newTagMessage}
              placeholder="Message (optional)"
              aria-label="Annotated tag message"
              spellcheck="false"
            />
            <button class="action" type="submit" disabled={repo.busy || !newTagName.trim()}>
              Create
            </button>
          </form>
          <ul class="item-list">
            {#each repo.tags ?? [] as tag (tag.name)}
              <li class="item-row" title={tag.oid}>
                <span class="item-label">
                  <b>{tag.name}</b>
                  {tag.annotated ? ' (annotated)' : ''}
                </span>
                <button class="item-action" onclick={() => handlePushTag(tag.name)} disabled={repo.busy} title="Push tag to remote">Push</button>
                <button class="item-action" onclick={() => handleDeleteTag(tag.name)} disabled={repo.busy} title="Delete tag">×</button>
              </li>
            {:else}
              <li class="overflow-note">No tags</li>
            {/each}
          </ul>
          {#if remotes.length > 1}
            <div class="tag-push-row">
              <span class="overflow-note">Push tag to:</span>
              <select bind:value={tagPushRemote} class="compare-select">
                {#each remotes as remote}
                  <option value={remote}>{remote}</option>
                {/each}
              </select>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if publishBranch}
    <div class="publish-bar" role="status">
      <span class="publish-message">Branch <b>{publishBranch}</b> has no upstream — publish to:</span>
      {#if remotes.length}
        <select bind:value={publishRemote} class="compare-select">
          {#each remotes as remote}
            <option value={remote}>{remote}</option>
          {/each}
        </select>
      {:else}
        <span class="overflow-note">origin</span>
      {/if}
      <button class="action" onclick={handlePublish} disabled={repo.busy}>Publish</button>
    </div>
  {/if}

  {#if actionError}
    <p class="overflow-error" role="alert">{actionError}</p>
  {/if}
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
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .branch-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    min-width: 0;
  }

  .branch-button:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .branch-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .branch-chevron {
    font-size: 10px;
    color: var(--color-muted);
  }

  .toolbar-spacer {
    flex: 1;
  }

  .active-op {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    color: var(--color-muted);
    font-size: 11px;
  }

  .active-op-text {
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }

  .icon-button:hover {
    background: var(--color-selected-bg);
    border-color: var(--color-border);
  }

  .icon-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .icon-button:disabled:hover {
    background: transparent;
    border-color: transparent;
  }

  .overflow-toggle {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -1px;
  }

  .dropdown {
    position: relative;
    z-index: 20;
    padding: 0.4rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    max-height: 400px;
    overflow-y: auto;
  }

  .branch-dropdown {
    padding: 0.5rem 0.75rem;
  }

  .overflow-dropdown {
    padding: 0.25rem 0;
  }

  .overflow-item {
    display: block;
    width: 100%;
    padding: 4px 0.75rem;
    border: none;
    background: transparent;
    color: var(--color-fg);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .overflow-item:hover {
    background: var(--color-selected-bg);
  }

  .overflow-panel {
    padding: 0.25rem 0.75rem 0.5rem;
  }

  .create-form {
    display: flex;
    gap: 0.35rem;
    margin-bottom: 0.35rem;
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

  .branch-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .branch-list.remote {
    margin-top: 0.35rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--color-border);
  }

  .branch-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .branch-item + .branch-item {
    margin-top: 1px;
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

  .compare-panel {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0.25rem 0.75rem 0.35rem;
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
    font-size: 11px;
  }

  .compare-result {
    padding: 0 0.75rem 0.35rem;
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

  .check-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--color-muted);
    white-space: nowrap;
  }

  .item-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .item-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 2px 0;
  }

  .item-row + .item-row {
    border-top: 1px solid var(--color-border);
  }

  .item-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
  }

  .item-action {
    padding: 0 6px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    font-size: 11px;
    cursor: pointer;
    border-radius: 4px;
  }

  .item-action:hover:not(:disabled) {
    color: var(--color-danger);
  }

  .item-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .overflow-note {
    padding: 2px 0;
    font-size: 11px;
    color: var(--color-muted);
    margin: 0;
  }

  .overflow-error {
    padding: 2px 0.75rem;
    font-size: 11px;
    color: var(--color-danger);
    margin: 0;
    word-break: break-word;
  }

  .publish-bar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 11px;
    flex-wrap: wrap;
  }

  .publish-message {
    color: var(--color-muted);
  }

  .tag-push-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.35rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--color-border);
  }

  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
