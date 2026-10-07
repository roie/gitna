'use client';

import type { ThemesType } from '@pierre/diffs';
import { useWorkerPool } from '@pierre/diffs/react';
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';

// Keeps the long-lived diffs worker pool on the same light/dark theme pair as
// the themed React surface. Non-worker rendering still receives the pair
// through component options; this hook only covers WorkerPoolContext consumers.
export function useWorkerDiffTheme(theme: ThemesType, disabled: boolean): boolean {
  const workerPool = useWorkerPool();
  const subscribe = useCallback(
    (onChange: () => void) => workerPool?.subscribeToStatChanges(onChange) ?? (() => {}),
    [workerPool]
  );
  const getSnapshot = useCallback(
    () => workerPool != null && !workerPool.isWorkingPool(),
    [workerPool]
  );
  const workersFailed = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const workerPoolDisabled = disabled || workersFailed;
  useLayoutEffect(() => {
    if (workerPoolDisabled || workerPool == null) return;
    void workerPool.setRenderOptions({ theme });
  }, [workerPoolDisabled, theme, workerPool]);
  return workerPoolDisabled;
}
