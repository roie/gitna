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
  return renderer.renderFullHTML(result!)
}

function start(contents: string, options: Record<string, unknown> = {}) {
  const renderer = new FileRenderer({ theme: 'github-dark', ...options })
  const file = renderer.startEditSession({ name: 'notes.txt', contents })
  return { file, renderer }
}

describe('plain-text editor viewport rendering', () => {
  it('keeps edited contents lazy instead of joining every line', () => {
    const original = Array.from({ length: 2000 }, (_, line) => `line ${line}\n`).join('')
    const { file, renderer } = start(original)
    renderWindow(renderer, file, 0)
    const document = new TextDocument<'file', undefined>(file.name, file.contents)
    const getText = vi.spyOn(document, 'getText')
    const change = document.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        newText: 'edited',
      },
    ])!
    renderer.applyChange(change, document)
    expect(getText.mock.calls.some(([range]) => range === undefined)).toBe(false)
    expect(file.contents).toBe(`edited${original.slice(4)}`)
    renderWindow(renderer, file, 1997)
    renderer.cleanUp()
  })

  it('renders replacement and undo across the windowed-edit threshold', () => {
    const original = 'const value = 1;\n'.repeat(5)
    const { file, renderer } = start(original, { tokenizeMaxLength: 2 })
    expect(renderWindow(renderer, file, 0)).toContain('const')
    expect(renderer.editorRenderReady()).toBe(true)
    const document = new TextDocument<'file', undefined>(file.name, original)
    const change = document.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
        newText: 'x',
      },
    ])!
    renderer.applyChange(change, document)
    expect(renderWindow(renderer, file, 0)).toContain('x')
    expect(file.contents).toBe('x')
    const undo = document.undo()![0]
    renderer.applyChange(undo, document)
    expect(renderWindow(renderer, file, 3)).toContain('const')
    expect(file.contents).toBe(original)
    renderer.cleanUp()
  })

  it('renders million-line edit sessions in bounded windows', async () => {
    const original = 'x\r\n'.repeat(999999) + 'END!'
    const { file, renderer } = start(original)
    const highlighter = await getSharedHighlighter({
      langs: ['text'],
      themes: ['github-dark'],
    })
    const tokenize = vi.spyOn(highlighter, 'codeToTokens')
    renderWindow(renderer, file, 0)
    expect(renderer.editorRenderReady()).toBe(true)
    for (const line of [999997, 20, 500000, 0]) {
      const html = renderWindow(renderer, file, line)
      expect(html).toContain(`data-line="${line + 1}"`)
      if (line === 999997) expect(html).toContain('END!')
    }
    expect(tokenize.mock.calls.every(([contents]) => contents.length < 100)).toBe(true)
    const document = new TextDocument<'file', undefined>(file.name, original)
    const change = document.applyEdits([
      {
        range: { start: { line: 999999, character: 4 }, end: { line: 999999, character: 4 } },
        newText: 'Z',
      },
    ])!
    renderer.applyChange(change, document)
    expect(renderWindow(renderer, file, 999997)).toContain('END!Z')
    expect(file.contents).toBe('x\r\n'.repeat(999999) + 'END!Z')
    const insert = document.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'first\r\n',
      },
    ])!
    renderer.applyChange(insert, document)
    expect(renderWindow(renderer, file, 999998)).toContain('END!Z')
    expect(renderWindow(renderer, file, 0)).toContain('first')
    const undo = document.undo()![0]
    renderer.applyChange(undo, document)
    expect(renderWindow(renderer, file, 999997)).toContain('END!Z')
    expect(renderer.editorRenderReady()).toBe(true)
    renderer.cleanUp()
  })

  it('invalidates on theme changes and session recreation', () => {
    const { file, renderer } = start(
      Array.from({ length: 2000 }, (_, line) => `line ${line}\n`).join(''),
    )
    renderWindow(renderer, file, 1997)
    renderer.mergeOptions({ theme: 'github-light' })
    expect(renderWindow(renderer, file, 1997)).toContain('line 1997')
    renderer.endEditSession()
    const replacement = { name: file.name, cacheKey: 'replacement', contents: 'replacement match' }
    expect(renderWindow(renderer, replacement, 0)).toContain('replacement match')
    renderer.recycle()
    const session = renderer.startEditSession(replacement)
    expect(renderWindow(renderer, session, 0)).toContain('replacement match')
    renderer.cleanUp()
  })
})
