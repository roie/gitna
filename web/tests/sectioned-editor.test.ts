import { describe, expect, it } from 'vite-plus/test'
import {
  SectionedEditor,
  EDITOR_SECTION_LENGTH,
  EXTREME_EDITOR_LINE_LENGTH,
} from '../src/lib/sectioned-editor'
import { hasLongEditorLine } from '../src/lib/editor-performance'

const original = 'START' + 'x'.repeat(6 * 1024 * 1024) + 'END'

function append(editor: SectionedEditor, value: string) {
  editor.select(editor.text.length, editor.text.length)
  editor.replace(
    editor.text + value,
    editor.text.length + value.length,
    editor.text.length + value.length,
  )
}

describe('sectioned editor', () => {
  it('keeps the rendered section bounded at the start, middle and end of a 6 MiB line', () => {
    const editor = new SectionedEditor('large.txt', original)
    expect(editor.text.startsWith('START')).toBe(true)
    for (const offset of [original.length / 2, original.length, 0]) {
      editor.reveal(offset)
      expect(editor.text.length).toBeLessThanOrEqual(EDITOR_SECTION_LENGTH)
      expect(editor.document.offsetAt(editor.viewState.selections![0]!.start)).toBe(offset)
    }
    expect(editor.document.getText()).toBe(original)
    expect(hasLongEditorLine(original, EXTREME_EDITOR_LINE_LENGTH)).toBe(true)
    expect(hasLongEditorLine('x\r\n'.repeat(1000000), EXTREME_EDITOR_LINE_LENGTH)).toBe(false)
  })

  it('edits distant sections and preserves document-wide undo, redo and selection', () => {
    const editor = new SectionedEditor('large.txt', original)
    editor.replace('A' + editor.text, 1, 1)
    editor.reveal(editor.length)
    append(editor, 'Z')
    expect(editor.document.getText()).toBe('A' + original + 'Z')
    expect(editor.history(false)).toBe(true)
    expect(editor.document.getText()).toBe('A' + original)
    expect(editor.history(false)).toBe(true)
    expect(editor.document.getText()).toBe(original)
    expect(editor.start).toBe(0)
    expect(editor.history(true)).toBe(true)
    expect(editor.history(true)).toBe(true)
    expect(editor.document.getText()).toBe('A' + original + 'Z')
    expect(editor.text.endsWith('ENDZ')).toBe(true)
  })

  it.each(['\n', '\r\n', '\r'])('preserves %j line endings during textarea edits', (eol) => {
    const contents = ['first', 'second', 'last', ''].join(eol)
    const editor = new SectionedEditor('mixed.txt', contents)
    editor.replace(editor.text.replace('second', 'new\nline'), 14, 14)
    expect(editor.document.getText()).toBe(['first', 'new', 'line', 'last', ''].join(eol))
    editor.history(false)
    expect(editor.document.getText()).toBe(contents)
  })

  it('does not normalize untouched mixed line endings', () => {
    const contents = 'one\r\ntwo\nthree\rfour'
    const editor = new SectionedEditor('mixed.txt', contents)
    editor.replace(editor.text.replace('two', 'TWO'), 7, 7)
    expect(editor.document.getText()).toBe('one\r\nTWO\nthree\rfour')
  })

  it('never splits a surrogate pair or CRLF at a section boundary', () => {
    for (const pair of ['😀', '\r\n']) {
      const contents = 'x'.repeat(EDITOR_SECTION_LENGTH - 1) + pair + 'tail'
      const editor = new SectionedEditor('unicode.txt', contents)
      expect(editor.end).toBe(EDITOR_SECTION_LENGTH - 1)
      editor.reveal(editor.end + EDITOR_SECTION_LENGTH / 2)
      expect(editor.document.getText()).toBe(contents)
    }
  })

  it('bounds the DOM after a large paste without losing any pasted text', () => {
    const editor = new SectionedEditor('paste.txt', 'original')
    const pasted = 'y'.repeat(100000)
    append(editor, pasted)
    expect(editor.text.length).toBeLessThanOrEqual(EDITOR_SECTION_LENGTH)
    expect(editor.document.getText()).toBe('original' + pasted)
    editor.history(false)
    expect(editor.document.getText()).toBe('original')
  })

  it('restores a distant caret from the existing editor view state', () => {
    const editor = new SectionedEditor('restore.txt', original, {
      selections: [
        {
          start: { line: 0, character: original.length },
          end: { line: 0, character: original.length },
          direction: 0,
        },
      ],
    })
    expect(editor.text.endsWith('END')).toBe(true)
    expect(editor.selectionStart).toBe(editor.text.length)
  })
})
