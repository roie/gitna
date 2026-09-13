import type { DraftRecord } from '../../lib/api'
import { Button } from '../components/Button'
import { Modal } from './Modal'

interface DraftRecoveryModalProps {
  drafts: readonly DraftRecord[]
  onClose(): void
  onDiscard(draft: DraftRecord): void
  onRestore(draft: DraftRecord): void
}

export function DraftRecoveryModal({
  drafts,
  onClose,
  onDiscard,
  onRestore,
}: DraftRecoveryModalProps) {
  return (
    <Modal title="Recover unsaved documents" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        These documents have durable local backups. Restore a copy or discard a backup.
      </p>
      <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
        {drafts.map((draft) => (
          <div
            key={`${draft.clientId}:${draft.documentId}`}
            className="rounded-md border border-border p-3"
          >
            <p className="truncate text-sm font-medium">{draft.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Revision {draft.revision} · {draft.contents.length.toLocaleString()} characters
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onDiscard(draft)}>
                Discard backup
              </Button>
              <Button type="button" size="sm" onClick={() => onRestore(draft)}>
                Restore copy
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Later
        </Button>
      </div>
    </Modal>
  )
}
