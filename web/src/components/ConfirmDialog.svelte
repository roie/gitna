<script lang="ts">
  import Button from './Button.svelte'

  interface Props {
    title: string
    message: string
    confirmLabel: string
    onConfirm(): void
    onCancel(): void
  }

  let { title, message, confirmLabel, onConfirm, onCancel }: Props = $props()
</script>

<div class="dialog-backdrop" role="presentation">
  <div
    class="dialog"
    role="alertdialog"
    aria-modal="true"
    tabindex="-1"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-message"
  >
    <h2 id="confirm-title" class="dialog-title">{title}</h2>
    <p id="confirm-message" class="dialog-message">{message}</p>
    <div class="dialog-actions">
      <Button variant="ghost" size="sm" onclick={onCancel}>Cancel</Button>
      <Button variant="destructive" size="sm" onclick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  </div>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(0 0 0 / 0.45);
  }

  .dialog {
    width: min(420px, calc(100vw - 2rem));
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--background);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.3);
  }

  .dialog-title {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
  }

  .dialog-message {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--muted-foreground);
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
