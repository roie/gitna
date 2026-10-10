import {
  splitByIndex,
  splitCenter,
  splitExtension,
  splitFirst,
  splitLast,
  splitLeafPath,
} from '../node_modules/@pierre/trees/dist/components/OverflowText.js'
import { describe, expect, it } from 'vite-plus/test'

const splitters = [splitCenter, splitExtension, splitLeafPath, splitByIndex, splitFirst, splitLast]

function boundaries(contents: string): Set<number> {
  return new Set([
    0,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(contents),
      ({ index, segment }) => index + segment.length,
    ),
  ])
}

describe('Pierre middle truncation', () => {
  it('keeps the reported emoji folder names intact', () => {
    expect(splitExtension('👩🏽💻 Priya')).toEqual(['👩🏽', '💻 Priya'])
    expect(splitExtension('👩🏽‍💻 Priya')).toEqual(['👩🏽‍💻', ' Priya'])
  })

  for (const contents of [
    '👩🏽‍💻 Priya',
    '🇺🇸🇫🇷 reports',
    'Ame\u0301lie',
    '👨‍👩‍👧‍👦',
    '🏳️‍🌈 folder',
    'a.\u0301txt',
    'a/\u0301file',
  ]) {
    it(`never divides a user-perceived character in ${contents}`, () => {
      const valid = boundaries(contents)
      for (const split of splitters) {
        for (let index = 0; index <= contents.length; index += 1) {
          const parts = split(contents, { splitIndex: index, splitOffset: index })
          expect(parts.join('')).toBe(contents)
          expect(valid.has(parts[0].length)).toBe(true)
        }
      }
    })
  }

  it('preserves ASCII split positions and filename priorities', () => {
    expect(splitCenter('abcdef')).toEqual(['abc', 'def'])
    expect(splitExtension('file.ts')).toEqual(['file.', 'ts'])
    expect(splitLeafPath('src/file.ts')).toEqual(['src/', 'file.ts'])
    expect(splitByIndex('abcdef', { splitIndex: 2 })).toEqual(['ab', 'cdef'])
    expect(splitFirst('abcdef', { splitOffset: 2 })).toEqual(['ab', 'cdef'])
    expect(splitLast('abcdef', { splitOffset: 2 })).toEqual(['abcd', 'ef'])
    for (const split of splitters) {
      expect(split('')).toEqual(['', ''])
      expect(split('a')).toEqual(['a', ''])
    }
  })
})
