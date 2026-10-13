export const MAX_WRAPPED_EDITOR_LINE_LENGTH = 16384

export function hasLongEditorLine(contents: string): boolean {
  let length = 0
  for (let index = 0; index < contents.length; index++) {
    const char = contents.charCodeAt(index)
    if (char === 10 || char === 13) length = 0
    else if (++length > MAX_WRAPPED_EDITOR_LINE_LENGTH) return true
  }
  return false
}
