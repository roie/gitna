import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { FileRenderer, getSharedHighlighter, type FileContents } from '@pierre/diffs'
import { TextDocument } from '@pierre/diffs/edit'

beforeAll(async () => {
  await getSharedHighlighter({
    preferredHighlighter: 'highlights',
    langs: ['text', 'javascript'],
    themes: ['github-dark', 'github-light'],
  })
})
afterEach(() => vi.restoreAllMocks())

function renderWindow(renderer: FileRenderer, file: FileContents, startingLine: number) {
  const result = renderer.renderFile(file, {
    startingLine,
    totalLines: 3,
    bufferBefore: 0,
    bufferAfter: 0,
  })
  expect(result).toBeDefined()
  return renderer.renderPartialHTML(result!.contentAST)
}

async function fixture(
  contents = Array.from({ length: 2000 }, (_, line) => `line ${line}`).join('\n'),
) {
  const file: FileContents = { name: 'notes.txt', contents }
  const renderer = new FileRenderer({ theme: 'github-dark' })
  renderer.beginEditSession(file)
  const highlighter = await getSharedHighlighter({ langs: ['text'], themes: ['github-dark'] })
  const tokenize = vi.spyOn(highlighter, 'codeToTokens')
  renderWindow(renderer, file, 0)
  return { file, renderer, tokenize }
}

describe('plain-text editor viewport rendering', () => {
  it('renders million-line edit sessions in bounded windows', async () => {
    const { file, renderer, tokenize } = await fixture('x\r\n'.repeat(999999) + 'END!')
    expect(renderer.editorRenderReady()).toBe(true)
    for (const line of [999997, 20, 500000, 0]) {
      const html = renderWindow(renderer, file, line)
      expect(html).toContain(`data-line="${line + 1}"`)
      if (line === 999997) expect(html).toContain('END!')
    }
    expect(tokenize.mock.calls.every(([contents]) => contents.length < 100)).toBe(true)
    renderer.updateRenderCache(new Map([[999999, [[0, '', 'END!Z']]]]), 'dark')
    expect(renderWindow(renderer, file, 999997)).toContain('END!Z')
    renderWindow(renderer, file, 0)
    expect(renderWindow(renderer, file, 999997)).toContain('END!Z')
    expect(file.contents).toBe('x\r\n'.repeat(999999) + 'END!Z')
    const document = new TextDocument<'file', undefined>(file.name, `first\r\n${file.contents}`)
    renderer.applyDocumentChange(document)
    expect(renderWindow(renderer, file, 999998)).toContain('END!Z')
    expect(renderWindow(renderer, file, 0)).toContain('first')
    renderer.applyDocumentChange(
      new TextDocument<'file', undefined>(file.name, 'x\r\n'.repeat(999999) + 'END!'),
    )
    expect(renderWindow(renderer, file, 999997)).toContain('END!')
    expect(renderer.editorRenderReady()).toBe(true)
    renderer.cleanUp()
  })

  it('reveals distant matches without retokenizing the entire unchanged document', async () => {
    const { file, renderer, tokenize } = await fixture()
    const initialCalls = tokenize.mock.calls.length
    expect(initialCalls).toBeGreaterThan(0)
    for (const line of [1997, 20, 1000, 1997, 0]) {
      expect(renderWindow(renderer, file, line)).toContain(`line ${line}`)
    }
    expect(tokenize).toHaveBeenCalledTimes(initialCalls)
    renderer.cleanUp()
  })

  it('keeps dirty rows visible after distant jumps', async () => {
    const { file, renderer } = await fixture()
    renderer.updateRenderCache(new Map([[1997, [[0, '', 'edited match']]]]), 'dark')
    expect(renderWindow(renderer, file, 1997)).toContain('edited match')
    renderWindow(renderer, file, 0)
    expect(renderWindow(renderer, file, 1997)).toContain('edited match')
    renderer.cleanUp()
  })

  it.each(['\n', '\r\n'])(
    'preserves shifted lines and structural rollback with %j line endings',
    async (eol) => {
      const original = ['first', 'match', 'last', ''].join(eol)
      const { file, renderer } = await fixture(original)
      renderer.applyDocumentChange(
        new TextDocument<'file', undefined>(file.name, `inserted${eol}${original}`),
      )
      const shifted = renderWindow(renderer, file, 1)
      expect(shifted).toContain('match')
      expect(shifted).toContain('data-line="3"')
      renderer.applyDocumentChange(new TextDocument<'file', undefined>(file.name, original))
      const restored = renderWindow(renderer, file, 0)
      expect(restored).toContain('match')
      expect(restored).toContain('data-line="2"')
      expect(restored).not.toContain('inserted')
      renderer.cleanUp()
    },
  )

  it('invalidates on theme changes, new files, and session recreation', async () => {
    const { file, renderer, tokenize } = await fixture()
    const initialCalls = tokenize.mock.calls.length
    renderer.mergeOptions({ theme: 'github-light' })
    expect(renderWindow(renderer, file, 1997)).toContain('line 1997')
    expect(tokenize.mock.calls.length).toBeGreaterThan(initialCalls)
    const replacement = { name: file.name, cacheKey: 'replacement', contents: 'replacement match' }
    expect(renderWindow(renderer, replacement, 0)).toContain('replacement match')
    renderer.recycle()
    renderer.beginEditSession(replacement)
    expect(renderWindow(renderer, replacement, 0)).toContain('replacement match')
    renderer.cleanUp()
  })
})
