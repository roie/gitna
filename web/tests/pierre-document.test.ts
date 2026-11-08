import { describe, expect, it, vi } from 'vite-plus/test'
import { TextDocument } from '@pierre/diffs/edit'

const source = 'Hello 👩🏽‍💻 क्ष 각 שלום العربية\r\n世界 é\nlast\rtail'

describe('Pierre document text snapshots', () => {
  it('avoids full-buffer joins and preserves snapshots across edits and history branches', () => {
    const document = new TextDocument<'file', undefined>('file:///test.txt', source)
    document.applyResolvedEdits([{ start: 0, end: 0, text: 'A' }])
    const join = Array.prototype.join
    let materializations = 0
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      ...args
    ) {
      const result = join.apply(this, args)
      if (result.length >= source.length) materializations++
      return result
    })
    const snapshots: string[] = []
    try {
      for (let i = 0; i < 5; i++) snapshots.push(document.getText())
    } finally {
      spy.mockRestore()
    }
    expect(snapshots).toEqual(Array<string>(5).fill(`A${source}`))
    expect(materializations).toBe(0)
    document.undo()
    expect(document.getText()).toBe(source)
    document.redo()
    expect(document.getText()).toBe(`A${source}`)
    document.undo()
    document.applyResolvedEdits([{ start: 0, end: 0, text: 'B' }])
    expect(document.getText()).toBe(`B${source}`)
  })

  it('preserves exact text through mixed Unicode and line-ending mutations', () => {
    const document = new TextDocument<'file', undefined>('file:///test.txt', source)
    let expected = source
    let seed = 8173
    const random = (size: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % size
    }
    for (let i = 0; i < 1000; i++) {
      const characters = Array.from(expected)
      const index = random(characters.length + 1)
      const start = characters.slice(0, index).join('').length
      const insert = random(2) !== 0
      const text = insert ? ['x', '\r\n', '👩🏽‍💻', 'क्ष', '\t', 'שלום'][random(6)]! : ''
      const end = insert ? start : characters.slice(0, index + random(8)).join('').length
      document.applyResolvedEdits([{ start, end, text }])
      expected = expected.slice(0, start) + text + expected.slice(end)
      expect(document.getText()).toBe(expected)
      expect(document.getText()).toBe(expected)
    }
  })
})
