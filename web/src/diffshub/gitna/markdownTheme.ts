import { useEffect, useMemo, useState } from 'react'
import type { ColorScheme } from '@pierre/theming'
import { useThemeController } from '@pierre/theming/react'
import { themes } from '@pierre/highlights/themes/loader'
import { createHighlightsPlugin } from '@pierre/words/highlights'
import type { CodeHighlighterPlugin } from '@pierre/words/html'
import { themeController } from './ThemeRoot'

export interface MarkdownTheme {
  name: string
  plugin?: CodeHighlighterPlugin
  scheme: ColorScheme
}

export function useMarkdownTheme(): MarkdownTheme | undefined {
  const state = useThemeController(themeController)
  const scheme = state.resolvedColorScheme
  const name = scheme === 'dark' ? state.darkThemeName : state.lightThemeName
  const [loaded, setLoaded] = useState<MarkdownTheme>()
  const plain = useMemo(() => ({ name, scheme }), [name, scheme])
  useEffect(() => {
    let current = true
    void themes[name]?.().then(
      ({ default: theme }) => {
        if (current) setLoaded({ name, scheme, plugin: createHighlightsPlugin({ theme }) })
      },
      () => {
        if (current) setLoaded({ name, scheme })
      },
    )
    return () => {
      current = false
    }
  }, [name, scheme])
  return themes[name] == null ? plain : loaded
}
