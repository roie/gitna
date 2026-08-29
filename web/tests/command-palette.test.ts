import { describe, expect, it } from 'vitest'

import {
  COMMAND_PALETTE_RESULT_LIMIT,
  paletteTextMatches,
  rankPaletteFiles,
} from '../src/diffshub/gitna/commandPalette'

describe('command palette file ranking', () => {
  it('ranks exact basenames ahead of path and fuzzy matches', () => {
    const results = rankPaletteFiles(
      ['src/main.ts', 'main.ts', 'src/components/MainView.tsx', 'docs/maintenance.md'],
      'main.ts',
      [],
    )

    expect(results.map((result) => result.path)).toEqual([
      'main.ts',
      'src/main.ts',
      'src/components/MainView.tsx',
    ])
  })

  it('ranks recently opened files first when the query is empty', () => {
    const results = rankPaletteFiles(['a.ts', 'b.ts', 'c.ts'], '', ['a.ts', 'c.ts'])

    expect(results.map((result) => result.path)).toEqual(['c.ts', 'a.ts', 'b.ts'])
  })

  it('matches path components and marks duplicate basenames', () => {
    const results = rankPaletteFiles(
      ['client/src/index.ts', 'server/src/index.ts', 'docs/readme.md'],
      'server index',
      [],
    )

    expect(results[0]?.path).toBe('server/src/index.ts')
    expect(rankPaletteFiles(['client/index.ts', 'server/index.ts'], 'index', [])[0]).toMatchObject({
      duplicateName: true,
      parent: 'client',
    })
  })

  it('applies recency before the bounded cutoff used by ordinary folder search', () => {
    const results = rankPaletteFiles(
      ['a/main.go', 'b/main.go', 'z/main.go'],
      'main',
      ['z/main.go'],
      2,
    )

    expect(results.map((result) => result.path)).toEqual(['z/main.go', 'a/main.go'])
  })

  it('bounds rendered results', () => {
    const paths = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`)
    expect(rankPaletteFiles(paths, 'file', [])).toHaveLength(COMMAND_PALETTE_RESULT_LIMIT)
  })

  it('matches command words and initials without loose cross-command noise', () => {
    expect(paletteTextMatches('Toggle Diff Layout', 'tdl')).toBe(true)
    expect(
      paletteTextMatches('Open Recent Folder: gohere\nrecent history switch folder', 'toggle'),
    ).toBe(false)
    expect(paletteTextMatches('Change Theme', 'branch')).toBe(false)
  })
})
