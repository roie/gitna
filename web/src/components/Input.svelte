<!--
  Modified from Pierre DiffsHub apps/diffshub/components/Input.tsx at
  diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported from React/Tailwind to Svelte and component-scoped CSS.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  interface Props {
    size?: 'default' | 'lg' | 'sm'
    type?: string
    placeholder?: string
    value?: string
    disabled?: boolean
    class?: string
    spellcheck?: boolean
    'aria-label'?: string
    oninput?: (e: Event) => void
    onkeydown?: (e: KeyboardEvent) => void
  }

  let {
    size = 'default',
    type = 'text',
    placeholder,
    value = $bindable(''),
    disabled = false,
    class: className = '',
    spellcheck,
    'aria-label': ariaLabel,
    oninput,
    onkeydown,
  }: Props = $props()
</script>

<input
  {type}
  {placeholder}
  {disabled}
  {spellcheck}
  aria-label={ariaLabel}
  class="input input-{size} {className}"
  bind:value={value}
  oninput={oninput}
  onkeydown={onkeydown}
/>

<style>
  .input {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--foreground);
    font-family: inherit;
    outline: none;
    transition: color 0.15s ease, box-shadow 0.15s ease;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
  }

  :global(.dark) .input {
    background: color-mix(in srgb, var(--input) 30%, transparent);
  }

  .input::placeholder {
    color: var(--muted-foreground);
  }

  .input::selection {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .input:focus-visible {
    border-color: var(--ring);
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
  }

  .input:disabled {
    pointer-events: none;
    opacity: 0.5;
    cursor: not-allowed;
  }

  .input-default {
    height: 36px;
    padding: 0 12px;
    font-size: 14px;
    border-radius: 6px;
  }

  .input-lg {
    height: 40px;
    padding: 0 16px;
    font-size: 14px;
    border-radius: 6px;
  }

  .input-sm {
    height: 32px;
    padding: 0 8px;
    font-size: 12px;
    border-radius: 6px;
  }
</style>
