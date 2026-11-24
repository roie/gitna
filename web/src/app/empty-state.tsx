import type { ReviewRequest } from '../lib/api'

export function FolderEmptyState() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 [grid-area:viewer]">
      <section role="status" className="max-w-md text-center">
        <h2 className="text-sm font-medium text-foreground">Select a file from Explorer</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose a file to open and edit it.</p>
      </section>
    </div>
  )
}

export function GitnaEmptyState({ scope }: { scope?: ReviewRequest['scope'] }) {
  const workingTree = scope === 'staged' || scope === 'unstaged'
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 [grid-area:viewer]">
      <section role="status" className="max-w-md text-center">
        <h2 className="text-sm font-medium text-foreground">
          {workingTree ? 'Working tree clean' : 'No differences'}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {workingTree
            ? 'There are no files to review in this scope.'
            : 'The selected references contain no changed files.'}
        </p>
      </section>
    </div>
  )
}
