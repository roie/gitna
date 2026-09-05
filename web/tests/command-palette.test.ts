import { describe, expect, it } from 'vitest'

import {
  splitPaletteFileMatchIndices,
  paletteTextMatches,
} from '../src/diffshub/gitna/commandPalette'

describe('command palette file highlighting', () => {
  it('splits authoritative Unicode code-point indices between the parent and filename', () => {
    const matches = splitPaletteFileMatchIndices(
      'src/İndex.ts',
      'İndex.ts',
      'src',
      [0, 1, 2, 3, 4, 8, -1, 99],
    )
    expect([...matches.parent]).toEqual([0, 1, 2, 3])
    expect([...matches.name]).toEqual([0, 4])
  })

  it('keeps the authoritative separator match on the displayed parent slash', () => {
    const matches = splitPaletteFileMatchIndices(
      'client/index.ts',
      'index.ts',
      'client',
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    )
    expect([...matches.parent]).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...matches.name]).toEqual([0, 1])
  })

  it('assigns root-path matches only to the filename', () => {
    const matches = splitPaletteFileMatchIndices('package.json', 'package.json', '', [0, 1])
    expect([...matches.parent]).toEqual([])
    expect([...matches.name]).toEqual([0, 1])
  })
})

describe('command palette command matching', () => {
  it('matches command words and initials without loose cross-command noise', () => {
    expect(paletteTextMatches('Toggle Diff Layout', 'tdl')).toBe(true)
    expect(
      paletteTextMatches('Open Recent Folder: gohere\nrecent history switch folder', 'toggle'),
    ).toBe(false)
    expect(paletteTextMatches('Change Theme', 'branch')).toBe(false)
  })
})
