// Modified from the pinned DiffsHub donor: localRepository uses truthful
// local-Git loading copy while retaining every donor state and layout.
import { IconCiWarningFill, IconRefresh } from '@pierre/icons';

import { useChromeThemeProps } from './useChromeThemeProps';
import { Button } from '@/components/Button';
import { cn } from '@/lib/cn';
import { diffshubChromeMapping } from '@/lib/theme/diffshubChromeMapping';
import type { ViewerLoadState } from '@/lib/types';

interface DiffsHubStatusPanelProps {
  contentKind?: 'diff' | 'file';
  errorMessage: string | null;
  localRepository?: boolean;
  onRetry(): void;
  state: ViewerLoadState;
}

export function DiffsHubStatusPanel({
  contentKind = 'diff',
  errorMessage,
  localRepository = false,
  onRetry,
  state,
}: DiffsHubStatusPanelProps) {
  // Mirror the rest of the diffshub chrome so the loading screen sits on the
  // active Shiki theme's surface instead of the global light/dark palette.
  // Mounted before the viewer is available, so we lean on the same provider
  // useChromeThemeProps the header/sidebar use — the controller source keeps the
  // last-resolved theme, so this stays on-palette without flashing the default.
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  const themeChromeStyle =
    Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined;
  const isError = state === 'error';
  const fileContent = contentKind === 'file';
  const title = isError
    ? fileContent
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
          : 'Streaming diff';

  const message = isError
    ? (errorMessage ??
      (fileContent
        ? 'Failed to open the file, please try again.'
        : 'Failed to fetch the diff, please try again.'))
    : fileContent
      ? 'Reading the file from the local workspace…'
      : state === 'parsing'
        ? 'Parsing the patch and building the file tree…'
        : state === 'fetching'
          ? localRepository
            ? 'Fetching the patch from the local repository…'
            : 'Fetching the patch from GitHub…'
          : 'Reading the patch and showing files as they arrive…';

  return (
    <div
      className={cn(
        'col-span-full flex min-h-0 items-center justify-center p-6',
        themeChromeStyle == null && 'bg-background'
      )}
      style={themeChromeStyle}
    >
      <section
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
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          {message}
        </p>
        {isError && (
          <Button type="button" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        )}
      </section>
    </div>
  );
}
