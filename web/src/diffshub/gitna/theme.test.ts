import pierreDark from '@pierre/theme/pierre-dark'
import pierreLight from '@pierre/theme/pierre-light'
import type { ThemeLike } from '@pierre/theming'
import { shikiThemes } from '@pierre/theming/themes'
import { colorUtils, normalizeThemeColors } from '@pierre/theming/color'
import { describe, expect, it } from 'vite-plus/test'

import { tokens } from './theme'

async function loadDracula(): Promise<ThemeLike> {
  const descriptor = shikiThemes.getTheme('dracula')
  if (descriptor == null) throw new Error('dracula is not registered')
  const loaded = await descriptor.load()
  return 'default' in loaded ? loaded.default : loaded
}

const cases = [
  ['pierre-dark', Promise.resolve(pierreDark as ThemeLike)],
  ['pierre-light', Promise.resolve(pierreLight as ThemeLike)],
  ['dracula', loadDracula()],
] as const

describe('root theme tokens', () => {
  for (const [name, themePromise] of cases) {
    it(`derives the A4 mapping for ${name}`, async () => {
      const theme = await themePromise
      const result = tokens(theme)
      const normalized = normalizeThemeColors(theme).colors ?? {}
      const background = normalized['sideBar.background'] ?? theme.bg ?? ''
      const foreground =
        colorUtils.pickReadableForeground(background, [
          theme.colors?.['sideBar.foreground'],
          theme.colors?.['editor.foreground'],
          theme.fg,
        ]) ??
        theme.fg ??
        ''

      expect(result['--background']).toBe(background)
      expect(result['--sidebar']).toBe(background)
      expect(result['--diffshub-sidebar-bg']).toBe(background)
      expect(result['--popover']).toBe(`color-mix(in srgb, ${foreground} 7%, ${background})`)
      expect(result['--destructive']).toBeTruthy()
      expect(result['--gitna-git-added']).toBeTruthy()
      expect(result['color-scheme']).toBe(theme.type)
      expect(Object.values(result).every((value) => value.trim().length > 0)).toBe(true)
    })
  }

  it('falls back to the neutral palette for a theme without colors', () => {
    expect(tokens({})).toEqual(tokens({ bg: '#ffffff', fg: '#0a0a0a', type: 'light' }))
    expect(tokens({})['--background']).toBe('#ffffff')
  })
})
