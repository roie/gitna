import { type SyntheticEvent, useState } from 'react'

import type { WorktreeFile } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Modal } from '../../components/modal'
import { useLoadingIndicator } from '../../components/ui/loading'
import { useRepository } from '../../repository/repository-provider'

interface SaveAsProps {
  documentPath: string
  initialPath: string
  onClose: () => void
  onError: (error: string | null) => void
  onSaved: (path: string, file: WorktreeFile) => void
}

export function SaveAs({ documentPath, initialPath, onClose, onError, onSaved }: SaveAsProps) {
  const repository = useRepository()
  const [path, setPath] = useState(initialPath)
  const [submitting, setSubmitting] = useState(false)
  const submittingVisible = useLoadingIndicator(submitting)

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const destination = path.trim().replace(/^\/+|\/+$/g, '')
    if (destination.length === 0 || submitting) return
    const disabledReason = repository.getActionDisabledReason()
    if (disabledReason != null) return
    setSubmitting(true)
    onError(null)
    try {
      const file = await repository.saveUntitledDocument(documentPath, destination)
      onSaved(destination, file)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const disabledReason = repository.getActionDisabledReason()

  return (
    <Modal title="Save As" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label className="text-xs font-medium" htmlFor="gitna-save-as-path">
          Repository-relative path
        </label>
        <Input
          data-autofocus
          id="gitna-save-as-path"
          className="mt-2"
          autoComplete="off"
          spellCheck={false}
          value={path}
          onChange={(event) => setPath(event.currentTarget.value)}
        />
        {repository.getActionDisabledReason() != null && (
          <p className="mt-2 overflow-wrap-anywhere text-xs text-muted-foreground" role="note">
            {repository.getActionDisabledReason()}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Save As creates a new file and does not overwrite an existing destination.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={path.trim().length === 0 || submitting || disabledReason != null}
          >
            {submittingVisible ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
