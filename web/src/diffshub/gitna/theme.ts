import type { ThemeLike } from '@pierre/theming'
import { colorUtils, normalizeThemeColors } from '@pierre/theming/color'

import { deriveChromeTokens } from '../lib/theme/deriveChromeTokens'

export const THEME_TOKENS_STORAGE_KEY = 'diffshub-theme-tokens'

const NEUTRAL_THEME: ThemeLike = { bg: '#ffffff', fg: '#0a0a0a', type: 'light' }

function mix(percent: number, foreground: string, surface: string): string {
  return `color-mix(in srgb, ${foreground} ${percent}%, ${surface})`
}

export function tokens(theme: ThemeLike): Record<string, string> {
  const chrome = deriveChromeTokens(theme)
  if (chrome?.scrollbarThumb == null || chrome.scrollbarTrack == null) {
    return tokens(NEUTRAL_THEME)
  }
  const normalized = normalizeThemeColors(theme).colors ?? {}
  const raw = theme.colors ?? {}
  const { background, fg } = chrome
  const dark = colorUtils.isDarkSurface(background, fg)

  return {
    '--background': background,
    '--sidebar': background,
    '--diffshub-sidebar-bg': background,
    '--foreground': fg,
    '--card-foreground': fg,
    '--popover-foreground': fg,
    '--accent-foreground': fg,
    '--secondary-foreground': fg,
    '--sidebar-foreground': fg,
    '--muted-foreground': chrome.mutedFg,
    '--card': chrome.surface,
    '--popover': chrome.surface,
    '--muted': chrome.surfaceHover,
    '--accent': chrome.surfaceHover,
    '--secondary': chrome.surfaceHover,
    '--input': chrome.surfaceHover,
    '--sidebar-accent': chrome.surfaceHover,
    '--diffshub-popover-selected-bg': chrome.surfaceSelected,
    '--diffshub-popover-border': chrome.surfaceBorder,
    '--diffshub-annotation-border': chrome.surfaceBorder,
    '--border': chrome.border,
    '--border-opaque': chrome.borderOpaque,
    '--sidebar-border': chrome.borderOpaque,
    '--ring': chrome.ring,
    '--sidebar-ring': chrome.ring,
    '--primary': fg,
    '--primary-foreground': background,
    '--destructive': raw['errorForeground'] || raw['editorError.foreground'] || chrome.deletionFg,
    '--diffshub-card-bg': mix(6, fg, background),
    '--diffshub-card-hover-bg': mix(12, fg, background),
    '--diffshub-card-border': mix(12, fg, background),
    '--diffshub-annotation-hover-border': mix(28, fg, background),
    '--diffshub-comment-add-fg': chrome.additionFg,
    '--diffshub-comment-del-fg': chrome.deletionFg,
    '--gitna-git-added': normalized['gitDecoration.addedResourceForeground'] || chrome.additionFg,
    '--gitna-git-modified':
      normalized['gitDecoration.modifiedResourceForeground'] || (dark ? '#fbbf24' : '#b45309'),
    '--gitna-git-deleted':
      normalized['gitDecoration.deletedResourceForeground'] || chrome.deletionFg,
    '--diffshub-diff-separator': chrome.separator,
    '--diffshub-scrollbar-thumb-bg': chrome.scrollbarThumb,
    '--diffshub-scrollbar-track-bg': chrome.scrollbarTrack,
    '--gitna-search-match-fg': 'light-dark(#1f1f1f, #ffffff)',
    '--gitna-search-match-bg':
      raw['editor.findMatchHighlightBackground'] || 'light-dark(#ffe58a, #705600)',
    '--gitna-search-active-match-bg':
      raw['editor.findMatchBackground'] || 'light-dark(#ffc34d, #996c00)',
    '--gitna-overlay-shadow': 'none',
    'color-scheme': theme.type === 'dark' ? 'dark' : 'light',
  }
}

export function applyRootThemeTokens(
  theme: ThemeLike,
  root: HTMLElement = document.documentElement,
): void {
  const result = tokens(theme)
  for (const [property, value] of Object.entries(result)) {
    if (property === 'color-scheme') {
      root.style.colorScheme = value
    } else {
      root.style.setProperty(property, value)
    }
  }
  try {
    localStorage.setItem(THEME_TOKENS_STORAGE_KEY, JSON.stringify(result))
  } catch {
    return
  }
}
