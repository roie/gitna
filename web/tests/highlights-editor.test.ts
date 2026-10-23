import { expect, it, vi } from 'vite-plus/test'
import { getSharedHighlighter } from '@pierre/diffs'
import { TextDocument } from '@pierre/diffs/edit'

it.each([
  { count: 10, language: 'text' },
  { count: 1000000, language: 'text' },
  { count: 10, language: 'gitna-unsupported' },
])('refreshes edits and undo in $count-line $language documents', async ({ count, language }) => {
  const highlighter = await getSharedHighlighter({
    preferredHighlighter: 'highlights',
    langs: [],
    themes: ['pierre-dark'],
  })
  const document = new TextDocument('notes.txt', 'x\r\n'.repeat(count) + 'END!', language)
  const onDeferTokenize = vi.fn()
  const tokenizer = highlighter.createEditorTokenizer({
    textDocument: document,
    theme: 'pierre-dark',
    onDeferTokenize,
  })
  const range = {
    startingLine: count - 3,
    totalLines: 4,
    bufferBefore: 0,
    bufferAfter: 0,
  }
  function visibleTail(change: Parameters<typeof tokenizer.tokenize>[0]) {
    return tokenizer
      .tokenize(change, range, true)
      .get(count)
      ?.map((token) => token[2])
      .join('')
  }
  try {
    const change = document.applyEdits([
      {
        range: { start: { line: count, character: 4 }, end: { line: count, character: 4 } },
        newText: 'Z',
      },
    ])!
    expect(visibleTail(change)).toBe('END!Z')
    expect(visibleTail(document.undo()![0])).toBe('END!')
    expect(visibleTail(document.redo()![0])).toBe('END!Z')
    expect(onDeferTokenize).not.toHaveBeenCalled()
  } finally {
    tokenizer.dispose()
  }
})
