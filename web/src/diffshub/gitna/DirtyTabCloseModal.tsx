import { Modal } from './Modal'
import { Button } from '../components/Button'

interface DirtyTabCloseModalProps {
  dirtyPaths: readonly string[]
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
}

export function DirtyTabCloseModal({
  dirtyPaths,
  onCancel,
  onDiscard,
  onSave,
}: DirtyTabCloseModalProps) {
  const count = dirtyPaths.length
  const isUntitled = count === 1 && dirtyPaths[0].startsWith('untitled:')
  const title = isUntitled
    ? 'Save changes before closing?'
    : count === 1
      ? `Discard unsaved changes to ${dirtyPaths[0]}?`
      : 'Discard unsaved changes to these files?'

  return (
    <Modal title={title} role={isUntitled ? 'dialog' : 'alertdialog'} onClose={onCancel}>
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
          {isUntitled ? "Don't Save" : 'Discard changes'}
        </Button>
        <Button type="button" size="sm" onClick={onSave}>
          {isUntitled ? 'Save' : 'Save changes'}
        </Button>
      </div>
    </Modal>
  )
}
