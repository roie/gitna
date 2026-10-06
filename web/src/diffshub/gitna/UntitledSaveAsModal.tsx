import { type SyntheticEvent, useEffect, useRef, useState } from 'react'

import type { WorktreeFile } from '../../lib/types'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { Modal } from './Modal'
import { useRepository } from './repository'

interface UntitledSaveAsModalProps {
  documentPath: string
  initialPath: string
  onClose: () => void
  onError: (error: string) => void
  onSaved: (path: string, file: WorktreeFile) => void
}

export function UntitledSaveAsModal({
  documentPath,
  initialPath,
  onClose,
  onError,
  onSaved,
}: UntitledSaveAsModalProps) {
  const repository = useRepository()
  const [path, setPath] = useState(initialPath)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.setSelectionRange(path.length, path.length)
  }, [path.length])

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const destination = path.trim().replace(/^\/+|\/+$/g, '')
    if (destination.length === 0 || submitting) return
    const disabledReason = repository.getActionDisabledReason()
    if (disabledReason != null) return
    setSubmitting(true)
    onError('')
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
          ref={inputRef}
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
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
