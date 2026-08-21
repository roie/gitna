<script lang="ts">
  import { ApiError } from '../lib/api'
  import type { RepoState } from '../lib/repo-state.svelte'
  import type { Branch } from '../lib/types'
  import Button from './Button.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import GitOperationDialog from './GitOperationDialog.svelte'
  import Input from './Input.svelte'
  import PierreIcon from './PierreIcon.svelte'

  interface Props {
    repo: RepoState
    onClose?(): void
  }

  let { repo, onClose }: Props = $props()

  let branchOpen = $state(false)
  let overflowOpen = $state(false)
  let newBranchName = $state('')
  let actionError = $state<string | null>(null)
  let pendingDelete = $state<string | null>(null)
  let publishBranch = $state<string | null>(null)
  let publishRemote = $state('origin')

  let activeDialog = $state<'compare' | 'integrate' | 'stash' | 'tags' | null>(null)
  let stashMessage = $state('')
  let stashUntracked = $state(false)
  let pendingStashDrop = $state<string | null>(null)

  let newTagName = $state('')
  let newTagMessage = $state('')
  let tagTarget = $state('HEAD')
  let tagPushRemote = $state('origin')
  let pendingTagDelete = $state<string | null>(null)

  let compareFrom = $state('HEAD')
  let compareTo = $state('HEAD')
  let integrateTarget = $state('')

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

  function openDialog(dialog: 'compare' | 'integrate' | 'stash' | 'tags'): void {
    activeDialog = dialog
    overflowOpen = false
    if (dialog === 'stash') void repo.refreshStashes()
    if (dialog === 'tags' || dialog === 'compare') void repo.refreshTags()
    if (dialog === 'integrate' || dialog === 'tags' || dialog === 'compare') {
      void repo.refreshBranches()
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
    pendingStashDrop = ref
  }

  async function confirmStashDrop(): Promise<void> {
    const ref = pendingStashDrop
    pendingStashDrop = null
    if (ref) await run(() => repo.stashDrop(ref))
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
    pendingTagDelete = name
  }

  async function confirmTagDelete(): Promise<void> {
    const name = pendingTagDelete
    pendingTagDelete = null
    if (name) await run(() => repo.deleteTag(name))
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

  function handleIntegrate(kind: 'merge' | 'rebase'): void {
    const target = integrateTarget.trim()
    if (!target || repo.busy) return
    activeDialog = null
    void run(() => (kind === 'merge' ? repo.mergeBranch(target) : repo.rebaseBranch(target)))
  }

</script>

{#if repo.snapshot}
  <div class="toolbar">
    <span class="sidebar-mode" title="Source Control"><PierreIcon name="file-tree" size={12} /></span>
    <Button
      variant="ghost"
      size="icon-sm"
      class="branch-trigger"
      onclick={toggleBranch}
      aria-label={`Switch branch · ${repo.snapshot?.headBranch ?? repo.snapshot?.headOid?.slice(0, 8) ?? 'detached'}`}
      aria-expanded={branchOpen}
      title={`Switch branch · ${repo.snapshot.root}`}
    >
      <PierreIcon name="branch" size={12} />
    </Button>
    <span class="toolbar-spacer"></span>
    {#if repo.activeOpLabel}
      <span class="active-op" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span class="active-op-text">{repo.activeOpLabel}</span>
      </span>
    {/if}
    <Button variant="ghost" size="icon-sm" onclick={handleFetch} disabled={repo.busy} title="Fetch" aria-label="Fetch">
      <PierreIcon name="refresh" size={12} />
    </Button>
    <Button variant="ghost" size="icon-sm" onclick={toggleOverflow} aria-expanded={overflowOpen} title="More actions" aria-label="More actions">
      <PierreIcon name="ellipsis" size={12} />
    </Button>
    {#if onClose}
      <Button variant="ghost" size="icon-sm" class="mobile-close" onclick={onClose} aria-label="Close Source Control" title="Close Source Control">
        <PierreIcon name="close" size={12} />
      </Button>
    {/if}
  </div>

  {#if branchOpen}
    <div class="dropdown branch-dropdown">
      <form class="create-form" onsubmit={handleCreate}>
        <Input
          size="sm"
          bind:value={newBranchName}
          placeholder="New branch name"
          aria-label="New branch name"
          spellcheck={false}
        />
        <Button variant="outline" size="sm" type="submit" disabled={repo.busy || !newBranchName.trim()}>New</Button>
      </form>
      <ul class="branch-list">
        {#each localBranches as branch (branch.name)}
          <li class="branch-item">
            <button
              class="branch-name-button"
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
              <Button
                variant="ghost"
                size="icon-sm"
                onclick={() => handleDelete(branch)}
                disabled={repo.busy}
                aria-label={`delete ${branch.name}`}
                title="Delete branch"
              >
                ×
              </Button>
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
      <button class="overflow-item" onclick={() => { handlePull(); overflowOpen = false }} disabled={repo.busy}>
        Pull
      </button>
      <button class="overflow-item" onclick={() => { handlePush(); overflowOpen = false }} disabled={repo.busy}>
        Push
      </button>
      <div class="overflow-separator"></div>
      <button class="overflow-item" onclick={() => { void repo.refreshGraph(); overflowOpen = false }}>
        Refresh Graph
      </button>

      <button class="overflow-item" onclick={() => openDialog('compare')}>Compare refs…</button>
      <button class="overflow-item" onclick={() => openDialog('integrate')}>Merge or rebase…</button>
      <button class="overflow-item" onclick={() => openDialog('stash')}>Stashes…</button>
      <button class="overflow-item" onclick={() => openDialog('tags')}>Tags…</button>

    </div>
  {/if}

  {#if activeDialog === 'compare'}
    <GitOperationDialog title="Compare references" onClose={() => (activeDialog = null)}>
      <div class="dialog-form compare-form">
        <label>
          <span>From</span>
          <select bind:value={compareFrom} class="compare-select" aria-label="Compare from">
            {#each compareRefOptions as option (option.value + option.label)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>To</span>
          <select bind:value={compareTo} class="compare-select" aria-label="Compare to">
            {#each compareRefOptions as option (option.value + option.label)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <Button variant="outline" size="sm" onclick={handleCompare} disabled={repo.busy || compareFrom === compareTo}>
          Compare
        </Button>
      </div>
      {#if repo.compare}
        <div class="dialog-result">
          <span class="compare-title" title={repo.compare.label}>{repo.compare.label}</span>
          <Button variant="ghost" size="icon-sm" onclick={() => repo.clearCompare()} aria-label="Close compare">×</Button>
          {#if repo.compareError}
            <p class="overflow-error" role="alert">{repo.compareError}</p>
          {:else if repo.compareLoading}
            <p class="overflow-note">Loading…</p>
          {:else if repo.compareFiles.length === 0}
            <p class="overflow-note">No differences</p>
          {:else}
            <p class="overflow-note">{repo.compareFiles.length} changed {repo.compareFiles.length === 1 ? 'file' : 'files'} loaded in the review surface.</p>
          {/if}
        </div>
      {/if}
    </GitOperationDialog>
  {:else if activeDialog === 'integrate'}
    <GitOperationDialog title="Merge or rebase" onClose={() => (activeDialog = null)}>
      <div class="dialog-stack">
        <label class="field-label">
          <span>Branch or reference</span>
          <select bind:value={integrateTarget} class="compare-select" aria-label="Branch or reference">
            <option value="" disabled>Select a branch</option>
            {#each repo.branches ?? [] as branch (branch.name)}
              {#if !branch.current}
                <option value={branch.name}>{branch.name}{branch.remote ? ' (remote)' : ''}</option>
              {/if}
            {/each}
          </select>
        </label>
        <p class="dialog-help">Merge preserves both histories. Rebase reapplies the current branch on top of the selected reference.</p>
        <div class="dialog-actions">
          <Button variant="outline" size="sm" onclick={() => handleIntegrate('merge')} disabled={repo.busy || !integrateTarget}>Merge</Button>
          <Button variant="outline" size="sm" onclick={() => handleIntegrate('rebase')} disabled={repo.busy || !integrateTarget}>Rebase</Button>
        </div>
      </div>
    </GitOperationDialog>
  {:else if activeDialog === 'stash'}
    <GitOperationDialog title="Stashes" onClose={() => (activeDialog = null)}>
      <form class="dialog-form" onsubmit={handleStashPush}>
        <Input
          size="sm"
          bind:value={stashMessage}
          placeholder="Stash message"
          aria-label="Stash message"
          spellcheck={false}
        />
        <label class="check-label" title="Include untracked files">
          <input type="checkbox" bind:checked={stashUntracked} aria-label="Include untracked" />
          Include untracked
        </label>
        <Button variant="outline" size="sm" type="submit" disabled={repo.busy || !stashMessage.trim()}>Stash</Button>
      </form>
      <ul class="item-list dialog-list">
        {#each repo.stashes ?? [] as entry (entry.ref)}
          <li class="item-row" title={`${entry.branch}: ${entry.message}`}>
            <span class="item-label"><b>{entry.ref}</b> {entry.branch}: {entry.message}</span>
            <Button variant="ghost" size="xs" onclick={() => handleStashApply(entry.ref)} disabled={repo.busy} title="Apply without removing">Apply</Button>
            <Button variant="ghost" size="xs" onclick={() => handleStashPop(entry.ref)} disabled={repo.busy} title="Apply and remove">Pop</Button>
            <Button variant="ghost" size="xs" onclick={() => handleStashDrop(entry.ref)} disabled={repo.busy} title="Drop stash">Drop</Button>
          </li>
        {:else}
          <li class="overflow-note">No stashes</li>
        {/each}
      </ul>
    </GitOperationDialog>
  {:else if activeDialog === 'tags'}
    <GitOperationDialog title="Tags" onClose={() => (activeDialog = null)}>
      <form class="dialog-form tag-form" onsubmit={handleCreateTag}>
        <Input size="sm" bind:value={newTagName} placeholder="Tag name" aria-label="New tag name" spellcheck={false} />
        <label class="field-label">
          <span>Target</span>
          <select bind:value={tagTarget} class="compare-select" aria-label="Tag target">
            {#each tagTargets as target (target.value + target.label)}
              <option value={target.value}>{target.label}</option>
            {/each}
          </select>
        </label>
        <Input size="sm" bind:value={newTagMessage} placeholder="Message (optional)" aria-label="Annotated tag message" spellcheck={false} />
        <Button variant="outline" size="sm" type="submit" disabled={repo.busy || !newTagName.trim()}>Create</Button>
      </form>
      {#if remotes.length > 1}
        <label class="field-label remote-field">
          <span>Push to</span>
          <select bind:value={tagPushRemote} class="compare-select">
            {#each remotes as remote}<option value={remote}>{remote}</option>{/each}
          </select>
        </label>
      {/if}
      <ul class="item-list dialog-list">
        {#each repo.tags ?? [] as tag (tag.name)}
          <li class="item-row" title={tag.oid}>
            <span class="item-label"><b>{tag.name}</b>{tag.annotated ? ' (annotated)' : ''}</span>
            <Button variant="ghost" size="xs" onclick={() => handlePushTag(tag.name)} disabled={repo.busy}>Push</Button>
            <Button variant="ghost" size="xs" onclick={() => handleDeleteTag(tag.name)} disabled={repo.busy}>Delete</Button>
          </li>
        {:else}
          <li class="overflow-note">No tags</li>
        {/each}
      </ul>
    </GitOperationDialog>
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
      <Button variant="outline" size="sm" onclick={handlePublish} disabled={repo.busy}>Publish</Button>
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

{#if pendingStashDrop}
  <ConfirmDialog
    title={`Drop ${pendingStashDrop}?`}
    message="This permanently removes the stash. Gitna cannot undo this action."
    confirmLabel="Drop stash"
    onConfirm={() => void confirmStashDrop()}
    onCancel={() => (pendingStashDrop = null)}
  />
{/if}

{#if pendingTagDelete}
  <ConfirmDialog
    title={`Delete tag ${pendingTagDelete}?`}
    message="This deletes the local tag. A tag already pushed to a remote is not removed there."
    confirmLabel="Delete tag"
    onConfirm={() => void confirmTagDelete()}
    onCancel={() => (pendingTagDelete = null)}
  />
{/if}

<style>
  .toolbar {
    display: flex;
    flex: 0 0 44px;
    align-items: center;
    gap: 2px;
    padding: 4px 10px 4px 12px;
    border-bottom: 1px solid var(--color-border-opaque, var(--border));
    background: var(--diffshub-sidebar-bg, var(--background));
  }

  .toolbar :global(.btn) {
    color: var(--foreground);
  }

  .toolbar :global(.btn:hover),
  .toolbar :global(.btn:focus-visible) {
    background: transparent;
    color: var(--muted-foreground);
    box-shadow: none;
  }

  .sidebar-mode {
    display: inline-grid;
    width: 16px;
    height: 20px;
    place-items: center;
    color: var(--foreground);
  }

  .toolbar :global(.branch-trigger) {
    color: var(--muted-foreground);
  }

  :global(.mobile-close) {
    display: none;
  }

  .toolbar-spacer {
    flex: 1;
  }

  .active-op {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    color: var(--muted-foreground);
    font-size: 12px;
  }

  .active-op-text {
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown {
    position: relative;
    z-index: 20;
    padding: 4px;
    border-bottom: 1px solid var(--border);
    background: var(--background);
    max-height: 400px;
    overflow-y: auto;
  }

  .branch-dropdown {
    padding: 8px;
  }

  .overflow-dropdown {
    padding: 0;
  }

  .overflow-item {
    display: block;
    width: 100%;
    padding: 4px 8px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }

  .overflow-item:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .overflow-separator {
    height: 1px;
    margin: 4px 8px;
    background: var(--border);
  }

  .create-form {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
    align-items: center;
  }

  .branch-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .branch-list.remote {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }

  .branch-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .branch-item + .branch-item {
    margin-top: 1px;
  }

  .branch-name-button {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 12px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }

  .branch-name-button:hover:not(:disabled) {
    background: var(--accent);
  }

  .branch-name-button:disabled {
    cursor: default;
  }

  .branch-name-button.current .branch-name-label {
    font-weight: 600;
  }

  .branch-marker {
    width: 0.6rem;
    color: #009fff;
    text-align: center;
  }

  .branch-name-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .branch-track {
    color: var(--muted-foreground);
    white-space: nowrap;
  }

  .dialog-form {
    display: flex;
    align-items: end;
    gap: 8px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .dialog-form > :global(.input-wrap),
  .dialog-form > label {
    flex: 1;
    min-width: 0;
  }

  .dialog-form label,
  .field-label {
    display: grid;
    gap: 4px;
    color: var(--muted-foreground);
    font-size: 11px;
  }

  .dialog-stack {
    display: grid;
    gap: 12px;
  }

  .dialog-help {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .compare-select {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    font-size: 12px;
    font-family: inherit;
  }

  .dialog-result {
    padding-top: 12px;
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

  .check-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--muted-foreground);
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
    gap: 4px;
    padding: 2px 0;
  }

  .item-row + .item-row {
    border-top: 1px solid var(--border);
  }

  .item-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
  }

  .overflow-note {
    padding: 2px 0;
    font-size: 12px;
    color: var(--muted-foreground);
    margin: 0;
  }

  .overflow-error {
    padding: 2px 8px;
    font-size: 12px;
    color: var(--destructive, #ef4444);
    margin: 0;
    word-break: break-word;
  }

  .publish-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex-wrap: wrap;
  }

  .publish-message {
    color: var(--muted-foreground);
  }

  .remote-field {
    margin: 12px 0;
  }

  .dialog-list {
    max-height: 360px;
    margin-top: 12px;
    overflow-y: auto;
  }

  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--border);
    border-top-color: #009fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @media (width <= 767px) {
    :global(.mobile-close) {
      display: inline-flex;
    }

    .dialog-form {
      align-items: stretch;
      flex-direction: column;
    }

    .dialog-form > :global(.input-wrap),
    .dialog-form > label,
    .dialog-form > :global(.btn) {
      width: 100%;
    }

    .item-row {
      flex-wrap: wrap;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
