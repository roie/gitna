import { Modal } from './Modal'
import { Button } from '../components/Button'

interface DirtyTabCloseModalProps {
  dirtyPaths: readonly string[]
  onCancel(): void
  onDiscard(): void
  onSave(): void
}

export function DirtyTabCloseModal({
  dirtyPaths,
  onCancel,
  onDiscard,
  onSave,
}: DirtyTabCloseModalProps) {
  const count = dirtyPaths.length
  return (
    <Modal
      title={count === 1 ? 'Save changes before closing?' : 'Save changes before closing?'}
      onClose={onCancel}
    >
      <p className="text-sm text-muted-foreground">
        {count === 1
          ? `Save changes to ${dirtyPaths[0]} before closing this tab?`
          : `Save changes in these ${count} tabs before closing them?`}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
          Don&apos;t Save
        </Button>
        <Button type="button" size="sm" onClick={onSave}>
          Save
        </Button>
      </div>
    </Modal>
  )
}
