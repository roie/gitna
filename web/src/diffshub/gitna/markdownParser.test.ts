import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { parseMarkdown } from './markdownParser'

describe('worker Markdown parsing', () => {
  it.each([
    '# Heading\n\nA **bold** paragraph with `code` and [a link](local.md).',
    '- [x] Done\n- [ ] Todo\n\n~~removed~~ www.example.com\n\n| A | B |\n| - | - |\n| 1 | 2 |',
    '> quote\n\n```js\nconst x = 1\n```\n\n---',
    'Footnote[^a]\n\n[^a]: Footnote body',
    '<script>alert(1)</script>\n\nHello <b>world</b>\n\n<img src="external" onerror="alert(2)">',
  ])('retains the previous GFM and skipHtml output: %s', (value) => {
    const tree = structuredClone(parseMarkdown(value))
    const actual = renderToStaticMarkup(toJsxRuntime(tree, { Fragment, jsx, jsxs }))
    const previous = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        children: value,
        remarkPlugins: [remarkGfm],
        skipHtml: true,
      }),
    )
    expect(actual).toBe(previous)
  })

  it('keeps source positions through worker transfer for scroll sync', () => {
    const tree = structuredClone(parseMarkdown('# Heading\n\nParagraph\n\n- Item'))
    const lines: number[] = []
    renderToStaticMarkup(
      toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        passNode: true,
        components: {
          h1: ({ node }) => {
            lines.push(node!.position!.start.line)
            return null
          },
          p: ({ node }) => {
            lines.push(node!.position!.start.line)
            return null
          },
          li: ({ node }) => {
            lines.push(node!.position!.start.line)
            return null
          },
        },
      }),
    )
    expect(lines).toEqual([1, 3, 5])
  })
})
