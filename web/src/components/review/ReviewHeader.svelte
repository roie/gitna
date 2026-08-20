<!--
  Modified from Pierre DiffsHub components/DiffsHubHeader.tsx,
  chromeButtonStyles.ts, themeCatalog.ts, and themeController.ts at
  diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported from React/Radix/Tailwind to Svelte and local repository controls.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  import type { DiffIndicators } from '@pierre/diffs'
  import Button from '../Button.svelte'
  import DropdownMenu from '../DropdownMenu.svelte'
  import Switch from '../Switch.svelte'
  import { reviewPreferences, reviewThemeCatalog } from '../../lib/review-preferences.svelte'

  interface Props {
    title: string
    fileCount: number
    collapsed: boolean
    narrow: boolean
    onToggleCollapse(): void
    onOpenSourceControl?(): void
  }

  let { title, fileCount, collapsed, narrow, onToggleCollapse, onOpenSourceControl }: Props = $props()
  const lightThemes = reviewThemeCatalog.getThemes({ colorScheme: 'light' })
  const darkThemes = reviewThemeCatalog.getThemes({ colorScheme: 'dark' })

  function displayName(theme: (typeof lightThemes)[number]): string {
    return theme.displayName ?? theme.name.replaceAll('-', ' ')
  }
</script>

<header class="review-header">
  {#if narrow && onOpenSourceControl}
    <Button
      variant="ghost"
      size="icon-md"
      class="chrome-action"
      aria-label="Open Source Control"
      title="Open Source Control"
      onclick={onOpenSourceControl}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h4v11h-4zm7 0h4v11h-4zM6.5 8h3" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
    </Button>
  {/if}

  <div class="identity">
    <span class="title" title={title}>{title}</span>
    <span class="count">{fileCount}</span>
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
        {#if reviewPreferences.diffStyle === 'split'}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4v9h-4zm7 0h4v9h-4z" fill="none" stroke="currentColor" stroke-width="1.25" /></svg>
        {:else}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zm0 4.5h11" fill="none" stroke="currentColor" stroke-width="1.25" /></svg>
        {/if}
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
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={collapsed ? 'm5 6 3-3 3 3M5 10l3 3 3-3' : 'm5 3 3 3 3-3M5 13l3-3 3 3'} fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </Button>

    <DropdownMenu ariaLabel="Theme settings">
      {#snippet trigger(toggle, open)}
        <Button
          variant="ghost"
          size="icon-md"
          class="chrome-action"
          aria-label="Theme settings"
          title="Theme settings"
          aria-haspopup="menu"
          aria-expanded={open}
          onclick={toggle}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {#if reviewPreferences.mode === 'dark'}
              <path d="M11.7 10.8A5 5 0 0 1 5.2 4.3 5 5 0 1 0 11.7 10.8Z" fill="none" stroke="currentColor" stroke-width="1.25" />
            {:else if reviewPreferences.mode === 'light'}
              <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.25" /><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
            {:else}
              <rect x="2" y="3" width="12" height="8.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25" /><path d="M6 14h4M8 11.5V14" stroke="currentColor" stroke-width="1.25" />
            {/if}
          </svg>
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
            {#each lightThemes as theme}
              <option value={theme.name}>{displayName(theme)}</option>
            {/each}
          </select>
        </label>
        <label class="select-row">
          <span>Dark theme</span>
          <select value={reviewPreferences.darkThemeName} onchange={(event) => reviewPreferences.setDarkTheme(event.currentTarget.value)}>
            {#each darkThemes as theme}
              <option value={theme.name}>{displayName(theme)}</option>
            {/each}
          </select>
        </label>
      {/snippet}
    </DropdownMenu>

    <DropdownMenu ariaLabel="Display settings">
      {#snippet trigger(toggle, open)}
        <Button variant="ghost" size="icon-md" class="chrome-action" aria-label="Display settings" title="Display settings" aria-haspopup="menu" aria-expanded={open} onclick={toggle}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 2.1h2.6l.4 1.5 1.3.7 1.5-.5 1.3 2.3-1.1 1.1v1.6l1.1 1.1-1.3 2.3-1.5-.5-1.3.7-.4 1.5H6.7l-.4-1.5-1.3-.7-1.5.5-1.3-2.3 1.1-1.1V7.2L2.2 6.1l1.3-2.3 1.5.5 1.3-.7.4-1.5Z" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linejoin="round" /><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.15" /></svg>
        </Button>
      {/snippet}
      {#snippet children()}
        <label class="setting-row"><span>Backgrounds</span><Switch checked={reviewPreferences.backgrounds} oncheckedchange={(value) => reviewPreferences.setBackgrounds(value)} /></label>
        <label class="setting-row"><span>Line numbers</span><Switch checked={reviewPreferences.lineNumbers} oncheckedchange={(value) => reviewPreferences.setLineNumbers(value)} /></label>
        <label class="setting-row"><span>Word wrap</span><Switch checked={reviewPreferences.overflow === 'wrap'} oncheckedchange={(value) => reviewPreferences.setOverflow(value ? 'wrap' : 'scroll')} /></label>
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
    position: relative;
    z-index: 30;
    display: flex;
    align-items: center;
    min-width: 0;
    min-height: 45px;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-border-opaque, var(--border));
    background: var(--diffshub-sidebar-bg, var(--background));
    color: var(--foreground);
    contain: layout;
  }
  .identity { display: flex; min-width: 0; align-items: center; gap: 7px; margin-right: auto; }
  .title { overflow: hidden; color: var(--foreground); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .count { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
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
    .review-header { min-height: 49px; padding-inline: 10px; }
    .title { max-width: 48vw; }
  }
  @media (pointer: coarse) {
    :global(.chrome-action) { width: 40px !important; height: 40px !important; }
  }
</style>
