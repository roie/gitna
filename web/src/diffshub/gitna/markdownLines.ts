export function headingLines(source: string): number[] {
  const lines: number[] = []
  let fence: string | null = null
  source.split('\n').forEach((text, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1]
    if (fence != null) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null
    } else if (marker != null) {
      fence = marker
    } else if (/^ {0,3}#{1,6}(\s|$)/.test(text)) {
      lines.push(index + 1)
    }
  })
  return lines
}

export function blockSourceLines(headings: boolean[], source: string): number[] {
  const known = headingLines(source)
  const lineCount = source.split('\n').length
  const anchors: { index: number; line: number }[] = []
  let next = 0
  headings.forEach((heading, index) => {
    if (heading && next < known.length) anchors.push({ index, line: known[next++]! })
  })
  if (anchors[0]?.index !== 0) anchors.unshift({ index: 0, line: 1 })
  anchors.push({ index: headings.length, line: lineCount + 1 })
  const lines: number[] = []
  for (let anchor = 0; anchor < anchors.length - 1; anchor++) {
    const from = anchors[anchor]!
    const to = anchors[anchor + 1]!
    for (let index = from.index; index < to.index; index++) {
      lines[index] =
        index === from.index
          ? from.line
          : Math.round(
              from.line + ((index - from.index) / (to.index - from.index)) * (to.line - from.line),
            )
    }
  }
  return lines
}
