import type { ThemeLike } from '@pierre/theming'
import { colorUtils, normalizeThemeColors } from '@pierre/theming/color'

import { deriveChromeTokens } from './chrome-tokens'

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
  const added = normalized['gitDecoration.addedResourceForeground'] || chrome.additionFg
  const highlight =
    raw['focusBorder'] || raw['textLink.foreground'] || raw['button.background'] || chrome.ring
  const modified =
    normalized['gitDecoration.modifiedResourceForeground'] || (dark ? '#fbbf24' : '#b45309')

  return {
    '--background': background,
    '--sidebar': background,
    '--gitna-sidebar-bg': background,
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
    '--gitna-popover-selected-bg': chrome.surfaceSelected,
    '--gitna-popover-border': chrome.surfaceBorder,
    '--gitna-annotation-border': chrome.surfaceBorder,
    '--border': chrome.border,
    '--border-opaque': chrome.borderOpaque,
    '--sidebar-border': chrome.borderOpaque,
    '--ring': chrome.ring,
    '--sidebar-ring': chrome.ring,
    '--primary': fg,
    '--primary-foreground': background,
    '--destructive': raw['errorForeground'] || raw['editorError.foreground'] || chrome.deletionFg,
    '--gitna-card-bg': mix(6, fg, background),
    '--gitna-card-hover-bg': mix(12, fg, background),
    '--gitna-card-border': mix(12, fg, background),
    '--gitna-annotation-hover-border': mix(28, fg, background),
    '--gitna-comment-add-fg': chrome.additionFg,
    '--gitna-comment-del-fg': chrome.deletionFg,
    '--gitna-git-added': added,
    '--gitna-git-modified': modified,
    '--gitna-git-deleted':
      normalized['gitDecoration.deletedResourceForeground'] || chrome.deletionFg,
    '--gitna-git-untracked': normalized['gitDecoration.untrackedResourceForeground'] || added,
    '--gitna-git-renamed': normalized['gitDecoration.renamedResourceForeground'] || '#007aff',
    '--gitna-warning':
      raw['editorWarning.foreground'] ||
      raw['notificationsWarningIcon.foreground'] ||
      raw['terminal.ansiYellow'] ||
      (dark ? '#fbbf24' : '#b45309'),
    '--gitna-highlight': highlight,
    '--gitna-list-highlight': raw['list.highlightForeground'] || highlight,
    '--gitna-agent': dark ? '#c4b5fd' : '#6d28d9',
    '--gitna-lane-1': highlight,
    '--gitna-lane-2': '#f59e0b',
    '--gitna-lane-3': '#a855f7',
    '--gitna-lane-4': '#10b981',
    '--gitna-lane-5': '#f43f5e',
    '--gitna-alert-note': dark ? '#4493f8' : '#0969da',
    '--gitna-alert-tip': dark ? '#3fb950' : '#1a7f37',
    '--gitna-alert-important': dark ? '#ab7df8' : '#8250df',
    '--gitna-alert-warning': dark ? '#d29922' : '#9a6700',
    '--gitna-alert-caution': dark ? '#f85149' : '#d1242f',
    '--gitna-diff-separator': chrome.separator,
    '--gitna-scrollbar-thumb-bg': chrome.scrollbarThumb,
    '--gitna-scrollbar-track-bg': chrome.scrollbarTrack,
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
