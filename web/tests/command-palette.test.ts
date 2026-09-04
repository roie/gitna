import { describe, expect, it } from 'vitest'

import { paletteTextMatches } from '../src/diffshub/gitna/commandPalette'

describe('command palette command matching', () => {
  it('matches command words and initials without loose cross-command noise', () => {
    expect(paletteTextMatches('Toggle Diff Layout', 'tdl')).toBe(true)
    expect(
      paletteTextMatches('Open Recent Folder: gohere\nrecent history switch folder', 'toggle'),
    ).toBe(false)
    expect(paletteTextMatches('Change Theme', 'branch')).toBe(false)
  })
})
