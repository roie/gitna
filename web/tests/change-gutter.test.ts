import { describe, expect, it } from 'vite-plus/test'
import { fileGutterChanges } from '../src/diffshub/gitna/changeGutter'

const changes = (before: string, after: string) => [...fileGutterChanges(before, after)]

describe('file gutter changes against the index', () => {
  it('leaves unchanged files clear, including empty files', () => {
    expect(changes('same\n', 'same\n')).toEqual([])
    expect(changes('', '')).toEqual([])
  })

  it('marks inserted lines without shifting the following context', () => {
    expect(changes('a\nb\n', 'a\nnew\nb\n')).toEqual([[2, { kind: 'added' }]])
    expect(changes('', 'a\nb\n')).toEqual([
      [1, { kind: 'added' }],
      [2, { kind: 'added' }],
    ])
  })

  it('marks replacements blue, including longer replacements', () => {
    expect(changes('a\nb\nc\n', 'a\nchanged\nc\n')).toEqual([[2, { kind: 'modified' }]])
    expect(changes('old\n', 'new\nextra\n')).toEqual([
      [1, { kind: 'modified' }],
      [2, { kind: 'modified' }],
    ])
  })

  it('anchors removed lines before the first line or after the preceding line', () => {
    expect(changes('a\nb\nc\n', 'b\nc\n')).toEqual([[1, { deletion: 'before' }]])
    expect(changes('a\nb\nc\n', 'a\nc\n')).toEqual([[1, { deletion: 'after' }]])
    expect(changes('a\nb\n', 'a\n')).toEqual([[1, { deletion: 'after' }]])
    expect(changes('a\nb\n', '')).toEqual([[1, { deletion: 'before' }]])
  })

  it('keeps a deletion notch alongside a shorter replacement', () => {
    expect(changes('a\nb\nc\nd\n', 'a\nnew\nd\n')).toEqual([
      [2, { kind: 'modified', deletion: 'after' }],
    ])
  })

  it('keeps separated changes at their current buffer line numbers', () => {
    expect(changes('a\nb\nc\nd\ne\nf\ng\nh\n', 'new\nb\nc\nd\ne\nf\ng\nextra\nh\n')).toEqual([
      [1, { kind: 'modified' }],
      [8, { kind: 'added' }],
    ])
  })

  it('handles CRLF and missing final newlines', () => {
    expect(changes('a\r\nb\r\n', 'a\r\nnew\r\n')).toEqual([[2, { kind: 'modified' }]])
    expect(changes('a\nb', 'a\nnew')).toEqual([[2, { kind: 'modified' }]])
  })
})
