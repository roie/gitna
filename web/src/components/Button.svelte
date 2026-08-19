<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  type Props = {
    variant?: 'default' | 'success' | 'destructive' | 'outline' | 'secondary' | 'tertiary' | 'muted' | 'ghost' | 'link'
    size?: 'xs' | 'default' | 'sm' | 'lg' | 'xl' | 'icon' | 'icon-md' | 'icon-sm' | 'icon-only'
    class?: string
    children: Snippet
  } & HTMLButtonAttributes

  let {
    variant = 'default',
    size = 'default',
    class: className = '',
    children,
    ...restProps
  }: Props = $props()
</script>

<button
  class="btn btn-{variant} btn-{size} {className}"
  {...restProps}
>
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    white-space: nowrap;
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
    border: 1px solid transparent;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
    transition: all 0.15s ease;
    outline: none;
    font-family: inherit;
  }

  .btn:focus-visible {
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
  }

  .btn:disabled {
    pointer-events: none;
    opacity: 0.5;
  }

  .btn:disabled:where(.btn-default, .btn-success, .btn-destructive) {
    box-shadow: none;
  }

  :global(svg) {
    pointer-events: none;
    flex-shrink: 0;
  }

  /* Variants */
  .btn-default {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: transparent;
  }
  .btn-default:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-success {
    background: #10b981;
    color: white;
    border-color: transparent;
  }
  .btn-success:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-destructive {
    background: var(--destructive, #ef4444);
    color: white;
    border-color: transparent;
  }
  .btn-destructive:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-outline {
    background: var(--background);
    color: var(--foreground);
    border-color: var(--border);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
  }
  .btn-outline:hover:not(:disabled) {
    background: var(--secondary);
    color: var(--accent-foreground, var(--foreground));
  }

  .btn-secondary {
    background: var(--secondary);
    color: var(--secondary-foreground);
    border-color: transparent;
  }
  .btn-secondary:hover:not(:disabled) {
    opacity: 0.8;
  }

  .btn-tertiary {
    background: rgb(23 23 23 / 0.1);
    color: var(--foreground);
    border-color: transparent;
    box-shadow: none;
  }

  .btn-muted {
    background: var(--secondary);
    color: color-mix(in srgb, var(--accent-foreground, var(--foreground)) 75%, transparent);
    border-color: transparent;
  }
  .btn-muted:hover:not(:disabled) {
    color: var(--accent-foreground, var(--foreground));
  }

  .btn-ghost {
    background: transparent;
    color: var(--foreground);
    border-color: transparent;
  }
  .btn-ghost:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-foreground, var(--foreground));
  }
  :global(.dark) .btn-ghost:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .btn-link {
    background: transparent;
    color: var(--primary);
    border-color: transparent;
    text-decoration: none;
    text-underline-offset: 4px;
  }
  .btn-link:hover:not(:disabled) {
    text-decoration: underline;
  }

  /* Sizes */
  .btn-xs {
    height: 22px;
    padding: 0 6px;
    font-size: 12px;
    border-radius: 4px;
    gap: 6px;
  }

  .btn-default:where(.btn) {
    height: 36px;
    padding: 0 14px 0 14px;
    border-radius: 8px;
  }

  .btn-sm {
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
    border-radius: 6px;
    gap: 6px;
  }

  .btn-lg {
    height: 40px;
    padding: 0 24px;
    font-size: 14px;
    border-radius: 6px;
  }

  .btn-xl {
    height: 44px;
    padding: 0 28px;
    font-size: 14px;
    border-radius: 6px;
  }

  .btn-icon {
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: 8px;
  }

  .btn-icon-md {
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 6px;
  }

  .btn-icon-sm {
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 4px;
  }

  .btn-icon-only {
    width: 16px;
    height: 16px;
    padding: 0;
    border-radius: 0;
  }
</style>
