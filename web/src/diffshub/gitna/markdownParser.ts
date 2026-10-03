import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'

export type MarkdownTree = Parameters<typeof toJsxRuntime>[0]
export interface MarkdownParseRequest {
  id: number
  value: string
}
export type MarkdownParseResponse =
  | { id: number; tree: MarkdownTree }
  | { id: number; error: string }

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })

function removeHtml(tree: MarkdownTree): void {
  if ('children' in tree) {
    tree.children = tree.children.filter((node) => String(node.type) !== 'raw')
    tree.children.forEach(removeHtml)
  }
}

export function parseMarkdown(value: string): MarkdownTree {
  const tree = parser.runSync(parser.parse(value)) as MarkdownTree
  // Preserve skipHtml's surrounding whitespace, but never transfer raw HTML to the renderer.
  removeHtml(tree)
  return tree
}
