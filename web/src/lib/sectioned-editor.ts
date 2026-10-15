import { TextDocument, type EditorSelection, type EditorViewState } from '@pierre/diffs/edit'

export const EDITOR_SECTION_LENGTH = 16384
export const EXTREME_EDITOR_LINE_LENGTH = 262144

function normalized(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function rawOffset(text: string, offset: number): number {
  let raw = 0
  for (let index = 0; index < offset && raw < text.length; index++, raw++) {
    if (text[raw] === '\r' && text[raw + 1] === '\n') raw++
  }
  return raw
}

export class SectionedEditor {
  readonly document: TextDocument<'file', undefined>
  start = 0
  end = 0
  selectionStart = 0
  selectionEnd = 0

  constructor(path: string, contents: string, viewState?: EditorViewState) {
    this.document = new TextDocument(path, contents)
    const selection = viewState?.selections?.[0]
    this.reveal(
      selection == null ? 0 : this.document.offsetAt(selection.start),
      selection == null ? 0 : this.document.offsetAt(selection.end),
    )
  }

  get length(): number {
    return this.document.getText().length
  }

  get text(): string {
    return normalized(this.document.getTextSlice(this.start, this.end))
  }

  private boundary(offset: number): number {
    const text = this.document.getText()
    let result = Math.max(0, Math.min(text.length, offset))
    const before = text.charCodeAt(result - 1)
    const after = text.charCodeAt(result)
    if (
      (before === 13 && after === 10) ||
      (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    )
      result--
    return result
  }

  reveal(offset: number, selectionEnd = offset): void {
    const caret = this.boundary(offset)
    this.start = this.boundary(
      Math.max(0, Math.min(caret - EDITOR_SECTION_LENGTH / 2, this.length - EDITOR_SECTION_LENGTH)),
    )
    this.end = this.boundary(Math.min(this.length, this.start + EDITOR_SECTION_LENGTH))
    this.selectionStart = normalized(this.document.getTextSlice(this.start, caret)).length
    this.selectionEnd = normalized(
      this.document.getTextSlice(this.start, Math.min(this.end, selectionEnd)),
    ).length
  }

  select(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  get viewState(): EditorViewState & { selections: [EditorSelection] } {
    const raw = this.document.getTextSlice(this.start, this.end)
    const selection: EditorSelection = {
      start: this.document.positionAt(this.start + rawOffset(raw, this.selectionStart)),
      end: this.document.positionAt(this.start + rawOffset(raw, this.selectionEnd)),
      direction: this.selectionStart === this.selectionEnd ? 0 : 1,
    }
    return { selections: [selection] }
  }

  replace(text: string, selectionStart: number, selectionEnd: number): void {
    const previous = this.text
    let prefix = 0
    while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix])
      prefix++
    let suffix = 0
    while (
      suffix < previous.length - prefix &&
      suffix < text.length - prefix &&
      previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]
    )
      suffix++
    const raw = this.document.getTextSlice(this.start, this.end)
    const before = this.viewState.selections
    const offset = this.start + rawOffset(raw, prefix)
    const oldEnd = this.start + rawOffset(raw, previous.length - suffix)
    const inserted = this.document.normalizeEol(text.slice(prefix, text.length - suffix))
    this.document.applyEdits(
      [
        {
          range: { start: this.document.positionAt(offset), end: this.document.positionAt(oldEnd) },
          newText: inserted,
        },
      ],
      true,
      before,
      undefined,
      true,
    )
    this.end += inserted.length - (oldEnd - offset)
    this.select(selectionStart, selectionEnd)
    const after = this.viewState.selections
    this.document.setLastUndoSelectionsAfter(after)
    if (this.end - this.start > EDITOR_SECTION_LENGTH) {
      this.reveal(this.document.offsetAt(after[0].start), this.document.offsetAt(after[0].end))
    }
  }

  history(redo: boolean): boolean {
    const result = redo ? this.document.redo() : this.document.undo()
    if (result == null) return false
    const selection = result[1]?.[0]
    this.reveal(
      selection == null ? this.start : this.document.offsetAt(selection.start),
      selection == null ? this.start : this.document.offsetAt(selection.end),
    )
    return true
  }
}
