<!--
  Modified from Pierre DiffsHub apps/diffshub/components/Switch.tsx at
  diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
  Ported from React/Radix/Tailwind to a native Svelte switch and scoped CSS.
  Apache-2.0; Copyright 2025 Pierre Computer Company.
-->
<script lang="ts">
  interface Props {
    checked?: boolean
    disabled?: boolean
    class?: string
    'aria-label'?: string
    oncheckedchange?: (checked: boolean) => void
  }

  let {
    checked = $bindable(false),
    disabled = false,
    class: className = '',
    'aria-label': ariaLabel,
    oncheckedchange,
  }: Props = $props()

  function toggle(): void {
    if (disabled) return
    checked = !checked
    oncheckedchange?.(checked)
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      toggle()
    }
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {disabled}
  class="switch {className}"
  onclick={toggle}
  onkeydown={onkeydown}
>
  <span class="thumb" class:checked></span>
</button>

<style>
  .switch {
    display: inline-flex;
    align-items: center;
    width: 24px;
    height: 16px;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 9999px;
    cursor: pointer;
    transition: background-color 0.15s ease;
    background: var(--input);
    flex-shrink: 0;
  }

  .switch:focus-visible {
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
  }

  .switch[aria-checked='true'] {
    background: var(--primary);
  }

  .switch:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .thumb {
    display: block;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: var(--background);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    transform: translateX(0);
    transition: transform 0.15s ease;
  }

  .thumb.checked {
    transform: translateX(8px);
  }
</style>
