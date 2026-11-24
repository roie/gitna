import { describe, expect, it } from 'vite-plus/test'
import { blockSourceLines, headingLines } from './markdown-lines'

describe('Markdown source lines', () => {
  it('finds ATX headings outside fenced code', () => {
    const source = [
      '# Title',
      'text #notheading',
      '```md',
      '# inside',
      '``',
      '## still inside',
      '```',
      '   ### Indented',
      '~~~',
      '# tilde',
      '~~~',
      '####### seven',
      '#',
    ].join('\n')
    expect(headingLines(source)).toEqual([1, 8, 13])
  })

  it('places headings on their lines and spreads other blocks between them', () => {
    const source = ['intro', '', '# A', '', 'one', '', 'two', '', '# B', '', 'tail'].join('\n')
    expect(blockSourceLines([false, true, false, false, true, false], source)).toEqual([
      1, 3, 5, 7, 9, 11,
    ])
  })

  it('interpolates when rendered and source headings disagree', () => {
    expect(blockSourceLines([true, true, false], '# Only\n\ntext')).toEqual([1, 2, 3])
    expect(blockSourceLines([], '')).toEqual([])
  })
})
