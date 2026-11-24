// Modified by Gitna: retain local file/review loading, retry and size-consent states.
import { IconCiWarningFill, IconRefresh } from '@pierre/icons'
import { useLoadingIndicator } from '../../components/ui/loading'

import { Button } from '@/components/ui/button'
import type { ViewerLoadState } from '@/lib/review-types'

interface ReviewStatusProps {
  operation?: unknown
  contentKind?: 'diff' | 'file'
  errorMessage: string | null
  suppressError?: boolean
  onRetry?: () => void
  onOpenAnyway?: () => void
  state: ViewerLoadState
}

export function ReviewStatus({
  operation,
  contentKind = 'diff',
  errorMessage,
  onRetry,
  onOpenAnyway,
  suppressError = false,
  state,
}: ReviewStatusProps) {
  const isError = state === 'error'
  const loadingVisible = useLoadingIndicator(!isError, operation)
  if (isError && suppressError) return null
  const fileContent = contentKind === 'file'
  const title = isError
    ? onOpenAnyway != null
      ? 'Open large file?'
      : fileContent
        ? 'Couldn’t open file'
        : 'Couldn’t load diff'
    : state === 'parsing'
      ? fileContent
        ? 'Preparing file'
        : 'Preparing diff'
      : state === 'fetching'
        ? fileContent
          ? 'Opening file'
          : 'Fetching diff'
        : fileContent
          ? 'Opening file'
          : 'Streaming diff'

  const message = isError
    ? (errorMessage ??
      (fileContent
        ? 'Failed to open the file, please try again.'
        : 'Failed to fetch the diff, please try again.'))
    : fileContent
      ? 'Reading the file from the local folder…'
      : state === 'parsing'
        ? 'Parsing the patch and building the file tree…'
        : state === 'fetching'
          ? 'Fetching the patch from the local repository…'
          : 'Reading the patch and showing files as they arrive…'

  return (
    <div
      className="col-span-full flex min-h-0 items-center justify-center p-6"
      style={{ visibility: !isError && !loadingVisible ? 'hidden' : undefined }}
    >
      <section
        hidden={!isError && !loadingVisible}
        role={isError ? 'alert' : 'status'}
        aria-live="polite"
        aria-busy={!isError || undefined}
        className="w-full max-w-md p-5 text-center"
      >
        {isError ? (
          <IconCiWarningFill className="text-muted-foreground mx-auto mb-3 size-5" />
        ) : (
          <IconRefresh
            aria-hidden="true"
            className="text-muted-foreground mx-auto mb-3 size-5 -scale-x-100 animate-spin [animation-direction:reverse]"
          />
        )}
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm text-pretty">{message}</p>
        {isError && (onOpenAnyway != null || onRetry != null) && (
          <Button type="button" className="mbs-4" onClick={onOpenAnyway ?? onRetry}>
            {onOpenAnyway == null ? 'Try again' : 'Open anyway'}
          </Button>
        )}
      </section>
    </div>
  )
}
