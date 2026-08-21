<script lang="ts">
  import { onMount, type Snippet } from 'svelte'
  import Button from './Button.svelte'
  import PierreIcon from './PierreIcon.svelte'

  interface Props {
    title: string
    onClose(): void
    children: Snippet
  }

  let { title, onClose, children }: Props = $props()
  let panel = $state<HTMLElement>()

  onMount(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel?.focus()
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden)
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
      previous?.focus()
    }
  })
</script>

<div
  class="dialog-backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="git-operation-title"
    tabindex="-1"
    bind:this={panel}
  >
    <header class="dialog-header">
      <h2 id="git-operation-title">{title}</h2>
      <Button variant="ghost" size="icon-sm" onclick={onClose} aria-label={`Close ${title}`}>
        <PierreIcon name="close" size={12} />
      </Button>
    </header>
    <div class="dialog-content">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgb(0 0 0 / 0.45);
  }

  .dialog {
    display: flex;
    width: min(520px, 100%);
    max-height: min(680px, calc(100dvh - 32px));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--popover, var(--background));
    color: var(--foreground);
    box-shadow: var(--diffshub-popover-shadow, 0 16px 48px rgb(0 0 0 / 0.3));
    outline: none;
  }

  .dialog-header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dialog-content {
    min-height: 0;
    padding: 12px 16px 16px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  @media (width <= 767px) {
    .dialog-backdrop {
      align-items: end;
      padding: 0;
    }

    .dialog {
      width: 100%;
      max-height: calc(100dvh - 64px);
      border-width: 1px 0 0;
      border-radius: 14px 14px 0 0;
    }
  }
</style>
