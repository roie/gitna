// Modified by Gitna: use one theme controller with Gitna preference persistence and root tokens.
import { createThemeCatalog, createThemeController, type ThemePersistence } from '@pierre/theming'
import { useThemeController } from '@pierre/theming/react'
import { themes } from '@pierre/theming/themes'
import { type ReactNode, useLayoutEffect } from 'react'
import { savePreference } from '../preferences'
import { applyRootThemeTokens } from './theme'

export const themeCatalog = createThemeCatalog({
  themes,
  defaultLightThemeName: 'pierre-light-soft',
  defaultDarkThemeName: 'pierre-dark-soft',
})

function readPreference(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

const persistence: ThemePersistence = {
  load() {
    const mode = readPreference('theme')
    const light = readPreference('diffshub-light-theme')
    const dark = readPreference('diffshub-dark-theme')
    if (mode == null && light == null && dark == null) return null
    return {
      mode: mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system',
      lightThemeName: light ?? themeCatalog.defaultLightThemeName,
      darkThemeName: dark ?? themeCatalog.defaultDarkThemeName,
    }
  },
  save(selection) {
    savePreference('theme', selection.mode)
    savePreference('diffshub-light-theme', selection.lightThemeName)
    savePreference('diffshub-dark-theme', selection.darkThemeName)
  },
}

export const themeController = createThemeController({
  catalog: themeCatalog,
  persistence,
  defaultMode: 'system',
})

export function Theme({ children }: { children: ReactNode }) {
  const { resolvedColorScheme, resolvedTheme } = useThemeController(themeController)
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolvedColorScheme)
    root.style.colorScheme = resolvedColorScheme
    let meta = document.querySelector('meta[name="theme-color"]')
    if (meta == null) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', resolvedColorScheme === 'light' ? '#ffffff' : '#0a0a0a')
  }, [resolvedColorScheme])
  useLayoutEffect(() => {
    if (resolvedTheme != null) applyRootThemeTokens(resolvedTheme)
  }, [resolvedTheme])
  return children
}
