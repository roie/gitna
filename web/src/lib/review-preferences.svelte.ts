/**
 * Adapted from Pierre DiffsHub themeCatalog.ts, themeController.ts, and
 * ReviewUI.tsx at diffs-v1.3.5 (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
 * Replaces React providers with one framework-neutral controller-backed Svelte
 * store. Apache-2.0; Copyright 2025 Pierre Computer Company.
 */
import type { DiffIndicators } from '@pierre/diffs'
import {
  createThemeCatalog,
  createThemeController,
  type ColorMode,
  type ThemePersistence,
} from '@pierre/theming'
import { themes } from '@pierre/theming/themes'
import { applyChromeTheme } from './chrome-theme'

const MODE_KEY = 'gitna-color-mode'
const LIGHT_KEY = 'gitna-light-theme'
const DARK_KEY = 'gitna-dark-theme'
const SETTINGS_KEY = 'gitna-review-settings'

export const reviewThemeCatalog = createThemeCatalog({
  themes,
  defaultLightThemeName: 'pierre-light-soft',
  defaultDarkThemeName: 'pierre-dark-soft',
})

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Persistence is optional when storage is denied.
  }
}

const persistence: ThemePersistence = {
  load() {
    const mode = read(MODE_KEY)
    return {
      mode: mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system',
      lightThemeName: read(LIGHT_KEY) ?? reviewThemeCatalog.defaultLightThemeName,
      darkThemeName: read(DARK_KEY) ?? reviewThemeCatalog.defaultDarkThemeName,
    }
  },
  save(selection) {
    write(MODE_KEY, selection.mode)
    write(LIGHT_KEY, selection.lightThemeName)
    write(DARK_KEY, selection.darkThemeName)
  },
}

export const reviewThemeController = createThemeController({
  catalog: reviewThemeCatalog,
  persistence,
  defaultMode: 'system',
})

interface SavedReviewSettings {
  diffStyle?: 'split' | 'unified'
  overflow?: 'wrap' | 'scroll'
  backgrounds?: boolean
  lineNumbers?: boolean
  diffIndicators?: DiffIndicators
}

function loadSettings(): SavedReviewSettings {
  try {
    return JSON.parse(read(SETTINGS_KEY) ?? '{}') as SavedReviewSettings
  } catch {
    return {}
  }
}

const saved = loadSettings()
let themeState = $state(reviewThemeController.getState())
let diffStyle = $state<'split' | 'unified'>(saved.diffStyle === 'unified' ? 'unified' : 'split')
let overflow = $state<'wrap' | 'scroll'>(saved.overflow === 'wrap' ? 'wrap' : 'scroll')
let backgrounds = $state(saved.backgrounds ?? true)
let lineNumbers = $state(saved.lineNumbers ?? true)
let diffIndicators = $state<DiffIndicators>(
  saved.diffIndicators === 'classic' || saved.diffIndicators === 'none'
    ? saved.diffIndicators
    : 'bars',
)

function syncDocument(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const dark = themeState.resolvedColorScheme === 'dark'
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  if (themeState.resolvedTheme) applyChromeTheme(themeState.resolvedTheme)
}

reviewThemeController.subscribe(() => {
  themeState = reviewThemeController.getState()
  syncDocument()
})
syncDocument()

function saveSettings(): void {
  write(
    SETTINGS_KEY,
    JSON.stringify({ diffStyle, overflow, backgrounds, lineNumbers, diffIndicators }),
  )
}

export const reviewPreferences = {
  get mode() {
    return themeState.mode
  },
  get resolvedColorScheme() {
    return themeState.resolvedColorScheme
  },
  get resolvedTheme() {
    return themeState.resolvedTheme
  },
  get lightThemeName() {
    return themeState.lightThemeName
  },
  get darkThemeName() {
    return themeState.darkThemeName
  },
  get pendingTheme() {
    return themeState.pendingThemeResolution != null
  },
  get diffStyle() {
    return diffStyle
  },
  get overflow() {
    return overflow
  },
  get backgrounds() {
    return backgrounds
  },
  get lineNumbers() {
    return lineNumbers
  },
  get diffIndicators() {
    return diffIndicators
  },
  setMode(mode: ColorMode) {
    reviewThemeController.setColorMode(mode)
  },
  setLightTheme(name: string) {
    reviewThemeController.setThemeNameForScheme('light', name)
  },
  setDarkTheme(name: string) {
    reviewThemeController.setThemeNameForScheme('dark', name)
  },
  setDiffStyle(value: 'split' | 'unified') {
    diffStyle = value
    saveSettings()
  },
  setOverflow(value: 'wrap' | 'scroll') {
    overflow = value
    saveSettings()
  },
  setBackgrounds(value: boolean) {
    backgrounds = value
    saveSettings()
  },
  setLineNumbers(value: boolean) {
    lineNumbers = value
    saveSettings()
  },
  setDiffIndicators(value: DiffIndicators) {
    diffIndicators = value
    saveSettings()
  },
}

export type ReviewPreferences = typeof reviewPreferences
