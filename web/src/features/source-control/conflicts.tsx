import { message } from '../../components/tree-section'
import { Button } from '../../components/ui/button'
import type { ConflictEntry } from '../../lib/types'
import { useRepository } from '../../repository/repository'

export function Conflicts({ onError }: { onError: (error: string | null) => void }) {
  const repository = useRepository()
  const operation = repository.snapshot?.operation
  if (
    operation !== 'merge' &&
    operation !== 'rebase' &&
    operation !== 'cherry-pick' &&
    operation !== 'revert'
  )
    return null
  const disabledReason = repository.getActionDisabledReason()
  const labels: Record<string, string> = {
    merge: 'Merge in progress',
    rebase: 'Rebase in progress',
    'cherry-pick': 'Cherry-pick in progress',
    revert: 'Revert in progress',
  }
  const run = async (request: Parameters<typeof repository.operation>[0]) => {
    if (disabledReason != null) {
      onError(disabledReason)
      return
    }
    onError(null)
    try {
      await repository.operation(request)
    } catch (error) {
      onError(message(error))
    }
  }
  const unresolved = repository.conflicts.length
  return (
    <section className="conflict-bar mb-2 rounded-lg border border-warning/40 bg-warning/5 p-2">
      <div className="mb-2 flex items-center gap-2">
        <strong className="min-w-0 flex-1 text-xs">{labels[operation]}</strong>
        <span className="text-[11px] text-muted-foreground">{unresolved} unresolved</span>
      </div>
      {repository.conflicts.map((conflict: ConflictEntry) => (
        <div key={conflict.path} className="mb-1 flex items-center gap-1 text-xs">
          <span className="min-w-0 flex-1 truncate" title={conflict.path}>
            {conflict.path}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            onClick={() => void run({ op: 'resolve-ours', paths: [conflict.path] })}
          >
            Ours
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            onClick={() => void run({ op: 'resolve-theirs', paths: [conflict.path] })}
          >
            Theirs
          </Button>
          {conflict.canResolveBoth && (
            <Button
              size="xs"
              variant="outline"
              disabled={disabledReason != null}
              title={disabledReason ?? undefined}
              onClick={() => void run({ op: 'resolve-both', paths: [conflict.path] })}
            >
              Both
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            onClick={() =>
              void repository
                .mutate({ op: 'stage', paths: [conflict.path] })
                .catch((error) => onError(message(error)))
            }
          >
            Stage edited
          </Button>
        </div>
      ))}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabledReason != null}
          title={disabledReason ?? undefined}
          onClick={() => void run({ op: `${operation}-abort` as 'merge-abort' })}
        >
          Abort
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={unresolved > 0 || disabledReason != null}
          title={disabledReason ?? undefined}
          onClick={() => void run({ op: `${operation}-continue` as 'merge-continue' })}
        >
          Continue
        </Button>
      </div>
    </section>
  )
}
