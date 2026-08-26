import { type SyntheticEvent, useEffect, useRef, useState } from 'react'

import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { Modal } from './Modal'
import { useRepository } from './repository'

interface RepositoryEntryModalProps {
  initialPath: string
  kind: 'file' | 'folder' | 'rename'
  onClose(): void
  onCreatedFolder(path: string): void
  onError(error: string): void
  source?: string
}

export function RepositoryEntryModal({
  initialPath,
  kind,
  onClose,
  onCreatedFolder,
  onError,
  source,
}: RepositoryEntryModalProps) {
  const repository = useRepository()
  const [path, setPath] = useState(initialPath)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const title = kind === 'rename' ? 'Rename entry' : kind === 'folder' ? 'New folder' : 'New file'

  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  }, [])

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const destination = path.trim().replace(/\/$/, '')
    if (destination.length === 0 || submitting) return
    setSubmitting(true)
    onError('')
    try {
      if (kind === 'rename') {
        if (source == null || destination === source) {
          onClose()
          return
        }
        await repository.renameWorktreeEntry(source, destination)
        onClose()
      } else {
        await repository.createWorktreeEntry(destination, kind === 'folder')
        if (kind === 'folder') onCreatedFolder(destination)
        else onClose()
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label className="text-xs font-medium" htmlFor="gitna-repository-entry-path">
          Repository-relative path
        </label>
        <Input
          ref={inputRef}
          id="gitna-repository-entry-path"
          className="mt-2"
          autoComplete="off"
          spellCheck={false}
          value={path}
          onChange={(event) => setPath(event.currentTarget.value)}
        />
        {kind === 'folder' && (
          <p className="mt-2 text-xs text-muted-foreground">
            Git does not track empty folders, so Gitna will offer to create a file inside it next.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={path.trim().length === 0 || submitting}>
            {submitting ? 'Working…' : kind === 'rename' ? 'Rename' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
