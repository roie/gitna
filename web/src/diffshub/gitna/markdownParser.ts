import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
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
  .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '' })
  .use(rehypeRaw)
  .use(rehypeSanitize)

const CLOBBER_PREFIX = 'user-content-'

// The sanitizer prefixes ids; fragment links must follow, as on GitHub.
function prefixFragmentLinks(node: MarkdownTree): void {
  if (node.type === 'element' && node.tagName === 'a') {
    const href = node.properties.href
    if (typeof href === 'string' && href.startsWith('#') && !href.startsWith(`#${CLOBBER_PREFIX}`)) {
      node.properties.href = `#${CLOBBER_PREFIX}${href.slice(1)}`
    }
  }
  if ('children' in node) node.children.forEach(prefixFragmentLinks)
}

export function parseMarkdown(value: string): MarkdownTree {
  const tree = parser.runSync(parser.parse(value)) as MarkdownTree
  prefixFragmentLinks(tree)
  return tree
}
