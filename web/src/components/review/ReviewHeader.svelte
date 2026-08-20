<!--
  Modified from Pierre DiffsHub components/DiffsHubHeader.tsx,
  DiffsHubLogo.tsx, chromeButtonStyles.ts, themeCatalog.ts, and
  themeController.ts at diffs-v1.3.5
  (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported from React/Radix/Tailwind to Svelte around local repository identity.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import type { DiffIndicators } from '@pierre/diffs'
  import { reviewPreferences, reviewThemeCatalog } from '../../lib/review-preferences.svelte'
  import Button from '../Button.svelte'
  import DropdownMenu from '../DropdownMenu.svelte'
  import PierreIcon from '../PierreIcon.svelte'
  import Switch from '../Switch.svelte'

  interface Props {
    repository: string
    branch?: string
    context: string
    fileCount: number
    collapsed: boolean
    narrow: boolean
    onToggleCollapse(): void
    onOpenSourceControl?(): void
  }

  let {
    repository,
    branch,
    context,
    fileCount,
    collapsed,
    narrow,
    onToggleCollapse,
    onOpenSourceControl,
  }: Props = $props()

  const lightThemes = reviewThemeCatalog.getThemes({ colorScheme: 'light' })
  const darkThemes = reviewThemeCatalog.getThemes({ colorScheme: 'dark' })
  const repositoryName = $derived(repository.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repository)
  const identity = $derived(`${repositoryName}${branch ? ` / ${branch}` : ''} · ${context} · ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`)

  function displayName(theme: (typeof lightThemes)[number]): string {
    return theme.displayName ?? theme.name.replaceAll('-', ' ')
  }

  function setBackgrounds(checked: boolean): void {
    reviewPreferences.setBackgrounds(checked)
  }

  function setLineNumbers(checked: boolean): void {
    reviewPreferences.setLineNumbers(checked)
  }

  function setWordWrap(checked: boolean): void {
    reviewPreferences.setOverflow(checked ? 'wrap' : 'scroll')
  }
</script>

<header class="review-header">
  <div class="leading-actions">
    {#if narrow && onOpenSourceControl}
      <Button
        variant="ghost"
        size="icon-md"
        class="chrome-action"
        aria-label="Open Source Control"
        title="Open Source Control"
        onclick={onOpenSourceControl}
      >
        <PierreIcon name="file-tree-fill" />
      </Button>
    {/if}
  </div>

  <div class="brand" role="img" aria-label="Gitna">
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path fill="currentColor" d="M16 0c13.176 0 16 2.824 16 16s-2.824 16-16 16S0 29.176 0 16 2.824 0 16 0m5 16.625c-.621 0-1.125.504-1.125 1.125v2.125H17.75a1.125 1.125 0 0 0 0 2.25h2.125v2.125a1.125 1.125 0 0 0 2.25 0v-2.125h2.125a1.125 1.125 0 0 0 0-2.25h-2.125V17.75c0-.621-.504-1.125-1.125-1.125m-12.25 3.25a1.125 1.125 0 0 0 0 2.25h4.5a1.125 1.125 0 0 0 0-2.25zM11 6.625c-.621 0-1.125.504-1.125 1.125v2.125H7.75a1.125 1.125 0 0 0 0 2.25h2.125v2.125a1.125 1.125 0 0 0 2.25 0v-2.125h2.125a1.125 1.125 0 0 0 0-2.25h-2.125V7.75c0-.621-.504-1.125-1.125-1.125m7.75 3.25a1.125 1.125 0 0 0 0 2.25h4.5a1.125 1.125 0 0 0 0-2.25z" />
    </svg>
  </div>

  <div class="identity" title={`${repository} · ${branch ?? 'detached HEAD'} · ${context}`}>
    {identity}
  </div>

  <div class="actions">
    {#if !narrow}
      <Button
        variant="ghost"
        size="icon-md"
        class="chrome-action"
        title={reviewPreferences.diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'}
        aria-label={reviewPreferences.diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'}
        onclick={() => reviewPreferences.setDiffStyle(reviewPreferences.diffStyle === 'split' ? 'unified' : 'split')}
      >
        <PierreIcon name={reviewPreferences.diffStyle === 'split' ? 'diff-split' : 'diff-unified'} />
      </Button>
    {/if}

    <Button
      variant="ghost"
      size="icon-md"
      class="chrome-action"
      aria-pressed={collapsed}
      aria-label={collapsed ? 'Expand all files' : 'Collapse all files'}
      title={collapsed ? 'Expand all files' : 'Collapse all files'}
      onclick={onToggleCollapse}
    >
      <PierreIcon name={collapsed ? 'collapsed-row' : 'expand-all'} />
    </Button>

    <DropdownMenu ariaLabel="Theme settings">
      {#snippet trigger(toggle, open)}
        <Button variant="ghost" size="icon-md" class="chrome-action" aria-label="Theme settings" title="Theme settings" aria-haspopup="menu" aria-expanded={open} onclick={toggle}>
          <PierreIcon name={reviewPreferences.mode === 'dark' ? 'color-dark' : reviewPreferences.mode === 'light' ? 'color-light' : 'color-auto'} />
        </Button>
      {/snippet}
      {#snippet children()}
        <div class="menu-section" role="group" aria-label="Color mode">
          <span class="menu-label">Color mode</span>
          <div class="segments">
            {#each ['system', 'light', 'dark'] as mode}
              <button class:active={reviewPreferences.mode === mode} onclick={() => reviewPreferences.setMode(mode as 'system' | 'light' | 'dark')}>{mode}</button>
            {/each}
          </div>
        </div>
        <label class="select-row">
          <span>Light theme</span>
          <select value={reviewPreferences.lightThemeName} onchange={(event) => reviewPreferences.setLightTheme(event.currentTarget.value)}>
            {#each lightThemes as theme}<option value={theme.name}>{displayName(theme)}</option>{/each}
          </select>
        </label>
        <label class="select-row">
          <span>Dark theme</span>
          <select value={reviewPreferences.darkThemeName} onchange={(event) => reviewPreferences.setDarkTheme(event.currentTarget.value)}>
            {#each darkThemes as theme}<option value={theme.name}>{displayName(theme)}</option>{/each}
          </select>
        </label>
      {/snippet}
    </DropdownMenu>

    <DropdownMenu ariaLabel="Display settings">
      {#snippet trigger(toggle, open)}
        <Button variant="ghost" size="icon-md" class="chrome-action" aria-label="Display settings" title="Display settings" aria-haspopup="menu" aria-expanded={open} onclick={toggle}>
          <PierreIcon name="gear-fill" />
        </Button>
      {/snippet}
      {#snippet children()}
        <label class="setting-row"><span>Backgrounds</span><Switch checked={reviewPreferences.backgrounds} oncheckedchange={setBackgrounds} /></label>
        <label class="setting-row"><span>Line numbers</span><Switch checked={reviewPreferences.lineNumbers} oncheckedchange={setLineNumbers} /></label>
        <label class="setting-row"><span>Word wrap</span><Switch checked={reviewPreferences.overflow === 'wrap'} oncheckedchange={setWordWrap} /></label>
        <div class="setting-row">
          <span>Indicators</span>
          <div class="segments compact" aria-label="Diff indicator style">
            {#each ['bars', 'classic', 'none'] as indicator}
              <button class:active={reviewPreferences.diffIndicators === indicator} onclick={() => reviewPreferences.setDiffIndicators(indicator as DiffIndicators)}>{indicator}</button>
            {/each}
          </div>
        </div>
      {/snippet}
    </DropdownMenu>
  </div>
</header>

<style>
  .review-header {
    position: fixed;
    z-index: 30;
    inset: 0 0 auto;
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    height: 49px;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-border-opaque, var(--border));
    background: var(--diffshub-sidebar-bg, var(--background));
    color: var(--foreground);
    contain: layout;
  }
  .leading-actions { display: none; }
  .brand { display: grid; width: 24px; height: 24px; place-items: center; color: var(--foreground); }
  .brand svg { width: 24px; height: 24px; }
  .identity { min-width: 0; overflow: hidden; color: var(--muted-foreground); font-size: 14px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; align-items: center; }
  :global(.chrome-action) { color: var(--foreground); }
  :global(.chrome-action:hover), :global(.chrome-action:focus-visible) { background: transparent !important; color: var(--muted-foreground) !important; box-shadow: none !important; }
  :global(.chrome-action svg) { width: 16px; height: 16px; }
  .menu-section { display: grid; gap: 7px; padding: 4px 2px 10px; border-bottom: 1px solid var(--border); }
  .menu-label { color: var(--muted-foreground); font-size: 12px; }
  .segments { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; border-radius: 6px; background: var(--muted); }
  .segments button { min-height: 28px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent; color: var(--muted-foreground); font: inherit; font-size: 12px; text-transform: capitalize; cursor: pointer; }
  .segments button:hover { color: var(--foreground); }
  .segments button.active { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / .08); }
  .segments.compact { width: 150px; }
  .select-row, .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; padding: 5px 2px; font-size: 13px; }
  .select-row + .select-row { border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
  select { max-width: 166px; height: 28px; border: 1px solid var(--border); border-radius: 5px; background: var(--background); color: var(--foreground); font: inherit; font-size: 12px; }

  @media (width <= 767px) {
    .review-header {
      grid-template-areas: 'leading brand actions' 'identity identity identity';
      grid-template-columns: minmax(76px, 1fr) 24px minmax(76px, 1fr);
      grid-template-rows: 42px 53px;
      height: 110px;
      gap: 0;
      padding: 6px 16px 0;
      background: var(--background);
    }
    .leading-actions { grid-area: leading; display: flex; justify-self: start; }
    .brand { grid-area: brand; }
    .identity { grid-area: identity; align-self: stretch; padding: 16px 0 0; border-top: 1px solid var(--border); font-size: 14px; }
    .actions { grid-area: actions; justify-self: end; }
  }

  @media (pointer: coarse) {
    :global(.chrome-action) { width: 32px !important; height: 32px !important; }
  }
</style>
