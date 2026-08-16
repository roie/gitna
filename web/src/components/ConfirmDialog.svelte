<script lang="ts">
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
      <button class="dialog-button" onclick={onCancel}>Cancel</button>
      <button class="dialog-button dialog-button-danger" onclick={onConfirm}>
        {confirmLabel}
      </button>
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
    padding: 1rem 1.25rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.3);
  }

  .dialog-title {
    margin: 0 0 0.5rem;
    font-size: 14px;
    font-weight: 600;
  }

  .dialog-message {
    margin: 0 0 1rem;
    font-size: 12px;
    color: var(--color-muted);
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .dialog-button {
    padding: 4px 12px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-fg);
    font-size: 12px;
    cursor: pointer;
  }

  .dialog-button-danger {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
</style>
