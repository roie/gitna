/**
 * Modified from Pierre DiffsHub at diffs-v1.3.5
 * (59ec35ffac97abccef4c69f8d58d3747cbfbc6cb).
 *
 * Sources:
 * - apps/diffshub/lib/theme/deriveChromeTokens.ts
 * - apps/diffshub/lib/theme/diffshubChromeMapping.ts
 *
 * Adapted for Svelte: returns a Record<string, string> of CSS custom
 * properties instead of React CSSProperties.
 * Apache-2.0; Copyright 2025 Pierre Computer Company.
 */
import type { ThemeLike } from '@pierre/theming'
import { colorUtils, normalizeThemeColors } from '@pierre/theming/color'

export interface ChromeTokens {
  additionFg: string
  background: string
  border: string
  borderOpaque: string
  deletionFg: string
  fg: string
  mutedFg: string
  ring: string
  scrollbarThumb?: string
  scrollbarTrack?: string
  separator: string
  surface: string
  surfaceBorder: string
  surfaceHover: string
  surfaceSelected: string
  surfaceShadow: string
}

const MIN_MUTED_RATIO = 4.5
const DIFF_BORDER_MIX = 22

const cache = new WeakMap<ThemeLike, ChromeTokens | undefined>()

function pickReadableMuted(
  bg: string | undefined,
  mutedCandidate: string | undefined
): string | undefined {
  if (mutedCandidate == null || mutedCandidate === '') return undefined
  const composited =
    colorUtils.compositeOverBg(mutedCandidate, bg) ?? mutedCandidate
  const compositedL = colorUtils.relativeLuminance(composited)
  const bgL = colorUtils.relativeLuminance(bg)
  if (compositedL == null || bgL == null) {
    return mutedCandidate
  }
  return colorUtils.contrastRatio(bgL, compositedL) >= MIN_MUTED_RATIO
    ? mutedCandidate
    : undefined
}

export function deriveChromeTokens(theme: ThemeLike): ChromeTokens | undefined {
  const cached = cache.get(theme)
  if (cached !== undefined || cache.has(theme)) return cached

  const rawColors = theme.colors ?? {}
  const resolved = normalizeThemeColors(theme).colors ?? {}

  const sidebarBg = resolved['sideBar.background']
  const fg = colorUtils.pickReadableForeground(sidebarBg, [
    rawColors['sideBar.foreground'],
    rawColors['editor.foreground'],
    theme.fg,
  ])
  if (fg == null) {
    cache.set(theme, undefined)
    return undefined
  }

  const editorBg = resolved['editor.background'] ?? sidebarBg
  const editorFg = resolved['editor.foreground'] ?? fg
  const cardBase = sidebarBg ?? 'transparent'
  const muted =
    pickReadableMuted(sidebarBg, rawColors['descriptionForeground']) ??
    colorUtils.deriveMutedFg(fg, sidebarBg)
  const borderOpaque = `color-mix(in srgb, ${fg} ${DIFF_BORDER_MIX}%, ${sidebarBg ?? 'transparent'})`
  const surfaceIsDark = colorUtils.isDarkSurface(sidebarBg, fg)
  const separator =
    editorBg == null || colorUtils.surfacesMatch(editorBg, sidebarBg)
      ? borderOpaque
      : `color-mix(in srgb, ${editorFg} ${DIFF_BORDER_MIX}%, ${editorBg})`

  const tokens = Object.freeze({
    additionFg: surfaceIsDark ? '#34d399' : '#047857',
    background: sidebarBg ?? `color-mix(in srgb, ${fg} 7%, ${cardBase})`,
    border: `color-mix(in srgb, ${fg} 20%, transparent)`,
    borderOpaque,
    deletionFg: surfaceIsDark ? '#fb7185' : '#be123c',
    fg,
    mutedFg: muted,
    ring: fg,
    scrollbarThumb:
      editorBg != null
        ? colorUtils.isDarkSurface(editorBg, editorFg)
          ? `color-mix(in lab, ${editorBg} 80%, white)`
          : `color-mix(in lab, ${editorBg} 85%, black)`
        : undefined,
    scrollbarTrack: editorBg ?? undefined,
    separator,
    surface: `color-mix(in srgb, ${fg} 7%, ${cardBase})`,
    surfaceBorder: `color-mix(in srgb, ${fg} 18%, ${cardBase})`,
    surfaceHover: `color-mix(in srgb, ${fg} 14%, ${cardBase})`,
    surfaceSelected: `color-mix(in srgb, ${fg} 20%, ${cardBase})`,
    surfaceShadow: '0 8px 16px rgb(0 0 0 / 0.07), 0 2px 4px rgb(0 0 0 / 0.05)',
  })
  cache.set(theme, tokens)
  return tokens
}

export function diffshubChromeMapping(
  chrome: ChromeTokens | undefined,
  theme: ThemeLike
): Record<string, string> | undefined {
  const sidebarBg = normalizeThemeColors(theme).colors?.['sideBar.background']
  const bg =
    typeof sidebarBg === 'string' && sidebarBg !== '' ? sidebarBg : undefined

  if (chrome == null) {
    return bg != null ? { 'background-color': bg } : undefined
  }

  const fg = chrome.fg
  const base = bg ?? 'transparent'
  const style: Record<string, string> = {}
  if (bg != null) style['background-color'] = bg
  style['color'] = fg
  style['--foreground'] = fg
  style['--color-foreground'] = fg
  style['--muted-foreground'] = chrome.mutedFg
  style['--color-muted-foreground'] = chrome.mutedFg
  style['--border'] = chrome.border
  style['--color-border'] = chrome.border
  style['--border-opaque'] = chrome.borderOpaque
  style['--color-border-opaque'] = chrome.borderOpaque
  style['--diffshub-card-bg'] = `color-mix(in srgb, ${fg} 6%, ${base})`
  style['--diffshub-card-hover-bg'] = `color-mix(in srgb, ${fg} 12%, ${base})`
  style['--diffshub-card-border'] = `color-mix(in srgb, ${fg} 12%, ${base})`
  style['--popover'] = chrome.surface
  style['--color-popover'] = chrome.surface
  style['--popover-foreground'] = fg
  style['--color-popover-foreground'] = fg
  style['--diffshub-popover-bg'] = chrome.surface
  style['--diffshub-popover-fg'] = fg
  style['--diffshub-popover-muted-fg'] = chrome.mutedFg
  style['--diffshub-popover-hover-bg'] = chrome.surfaceHover
  style['--diffshub-popover-selected-bg'] = chrome.surfaceSelected
  style['--diffshub-popover-border'] = chrome.surfaceBorder
  style['--diffshub-popover-shadow'] = chrome.surfaceShadow
  style['--card'] = chrome.surface
  style['--color-card'] = chrome.surface
  style['--card-foreground'] = fg
  style['--color-card-foreground'] = fg
  style['--background'] = chrome.background
  style['--color-background'] = chrome.background
  style['--accent'] = chrome.surfaceHover
  style['--color-accent'] = chrome.surfaceHover
  style['--accent-foreground'] = fg
  style['--color-accent-foreground'] = fg
  style['--secondary'] = chrome.surfaceHover
  style['--color-secondary'] = chrome.surfaceHover
  style['--secondary-foreground'] = fg
  style['--color-secondary-foreground'] = fg
  style['--input'] = chrome.surfaceHover
  style['--color-input'] = chrome.surfaceHover
  style['--muted'] = chrome.surfaceHover
  style['--color-muted'] = chrome.surfaceHover
  style['--primary'] = fg
  style['--color-primary'] = fg
  style['--primary-foreground'] = chrome.background
  style['--color-primary-foreground'] = chrome.background
  style['--ring'] = chrome.ring
  style['--color-ring'] = chrome.ring
  style['--diffshub-comment-add-fg'] = chrome.additionFg
  style['--diffshub-comment-del-fg'] = chrome.deletionFg
  style['--diffshub-diff-separator'] = chrome.separator
  if (chrome.scrollbarThumb != null) {
    style['--diffshub-scrollbar-thumb-bg'] = chrome.scrollbarThumb
  }
  if (chrome.scrollbarTrack != null) {
    style['--diffshub-scrollbar-track-bg'] = chrome.scrollbarTrack
  }
  return style
}

export function applyChromeTheme(theme: ThemeLike): void {
  const chrome = deriveChromeTokens(theme)
  const vars = diffshubChromeMapping(chrome, theme)
  if (vars == null) return
  const root = document.documentElement
  for (const [prop, value] of Object.entries(vars)) {
    if (prop.startsWith('background') || prop === 'color') {
      root.style.setProperty(prop, value)
    } else {
      root.style.setProperty(prop, value)
    }
  }
}
