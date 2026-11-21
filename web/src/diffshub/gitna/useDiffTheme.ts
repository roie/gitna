// Modified by Gitna: feed the shared theme selection to Diffs and retain worker failure fallback.
import type { DiffsThemeNames, ThemesType } from '@pierre/diffs'
import { useWorkerPool } from '@pierre/diffs/react'
import { useThemeController } from '@pierre/theming/react'
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { themeController } from './ThemeRoot'

export function useDiffTheme() {
  const { lightThemeName, darkThemeName, resolvedColorScheme } = useThemeController(themeController)
  const theme = useMemo<ThemesType>(
    () => ({ light: lightThemeName as DiffsThemeNames, dark: darkThemeName as DiffsThemeNames }),
    [lightThemeName, darkThemeName],
  )
  const workerPool = useWorkerPool()
  const subscribe = useCallback(
    (onChange: () => void) => workerPool?.subscribeToStatChanges(onChange) ?? (() => {}),
    [workerPool],
  )
  const getSnapshot = useCallback(
    () => workerPool != null && !workerPool.isWorkingPool(),
    [workerPool],
  )
  const workersFailed = useSyncExternalStore(subscribe, getSnapshot, () => false)
  useLayoutEffect(() => {
    if (workersFailed || workerPool == null) return
    void workerPool.setRenderOptions({ theme })
  }, [workersFailed, theme, workerPool])
  return { theme, themeType: resolvedColorScheme, workersFailed }
}
