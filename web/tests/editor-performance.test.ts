import { describe, expect, it } from 'vite-plus/test'
import { hasLongEditorLine, MAX_WRAPPED_EDITOR_LINE_LENGTH } from '../src/lib/editor-performance'

describe('long-line wrapping policy', () => {
  it('keeps ordinary lines wrapped, including large multiline files', () => {
    expect(hasLongEditorLine('x'.repeat(MAX_WRAPPED_EDITOR_LINE_LENGTH))).toBe(false)
    expect(hasLongEditorLine('short line\r\n'.repeat(1000000))).toBe(false)
  })

  it.each(['\n', '\r\n', '\r'])('detects extreme lines with %j line endings', (eol) => {
    expect(hasLongEditorLine(`short${eol}${'x'.repeat(MAX_WRAPPED_EDITOR_LINE_LENGTH + 1)}`)).toBe(
      true,
    )
    expect(hasLongEditorLine(`${'x'.repeat(MAX_WRAPPED_EDITOR_LINE_LENGTH)}${eol}short`)).toBe(
      false,
    )
  })
})
