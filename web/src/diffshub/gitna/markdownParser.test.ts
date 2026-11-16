import { describe, expect, it } from 'vite-plus/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { parseMarkdown } from './markdownParser'

function render(value: string): string {
  return renderToStaticMarkup(
    toJsxRuntime(structuredClone(parseMarkdown(value)), { Fragment, jsx, jsxs }),
  )
}

describe('worker Markdown parsing', () => {
  it.each([
    '# Heading\n\nA **bold** paragraph with `code` and [a link](local.md).',
    '- [x] Done\n- [ ] Todo\n\n~~removed~~ www.example.com\n\n| A | B |\n| - | - |\n| 1 | 2 |',
    '> quote\n\n```js\nconst x = 1\n```\n\n---',
  ])('retains the previous GFM output: %s', (value) => {
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

  it('renders README HTML and strips anything active', () => {
    const html = render(
      [
        '<p align="center"><picture>',
        '<source media="(prefers-color-scheme: dark)" srcset="dark.png">',
        '<img src="light.png" alt="Logo" width="112" height="112" onerror="alert(1)" style="position:fixed">',
        '</picture></p>',
        '',
        '<script>alert(2)</script><iframe src="https://example.com"></iframe>',
        '',
        '<a href="javascript:alert(3)" onclick="alert(4)">bad</a> <b>bold</b>',
        '',
        '<form action="/api"><input name="location"></form>',
        '<details><summary>More</summary><kbd>Ctrl</kbd></details>',
      ].join('\n'),
    )
    expect(html).toContain(
      '<p align="center"><picture>\n<source media="(prefers-color-scheme: dark)" srcSet="dark.png"/>\n<img src="light.png" alt="Logo" width="112" height="112"/>',
    )
    expect(html).toContain('<a>bad</a> <b>bold</b>')
    expect(html).toContain('<details><summary>More</summary><kbd>Ctrl</kbd></details>')
    expect(html).toContain('<input disabled="" type="checkbox" name="user-content-location"/>')
    expect(html).not.toMatch(/script|iframe|onerror|onclick|javascript:|style=|<form/)
  })

  it('turns GitHub alert quotes into alerts without trusting raw SVG', () => {
    const html = render(
      '> [!WARNING]\n> Early <b>build</b>.\n\n> plain\n\n<p><svg onload="alert(1)"><path d="M0 0"/></svg></p>',
    )
    expect(html).toMatch(
      /^<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title"><svg class="octicon octicon-alert[^"]*"[^>]*aria-hidden="true">.*<\/svg>Warning<\/p><p>Early <b>build<\/b>\.<\/p>/s,
    )
    expect(html).toContain('<blockquote>\n<p>plain</p>\n</blockquote>')
    expect(html.match(/<svg/g)).toHaveLength(1)
    expect(html).not.toContain('onload')
  })

  it('prefixes HTML ids and keeps fragment links pointing at them', () => {
    const html = render('<h2 id="setup">Setup</h2>\n\n[Go](#setup) Footnote[^a]\n\n[^a]: Body')
    expect(html).toContain('<h2 id="user-content-setup">Setup</h2>')
    expect(html).toContain('<a href="#user-content-setup">Go</a>')
    expect(html).toContain('href="#user-content-fn-a" id="user-content-fnref-a"')
    expect(html).toContain('<li id="user-content-fn-a">')
    expect(html).toContain('aria-describedby="user-content-footnote-label"')
    expect(html).toContain('id="user-content-footnote-label"')
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
