import DOMPurify from 'dompurify'
import { renderToHtml } from '@pierre/words'
import { createHtmlRenderer } from '@pierre/words/html'
import { blockSourceLines } from './markdownLines'
import type { MarkdownTheme } from './markdownTheme'

const PREFIX = 'user-content-'

const TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'source',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'tt',
  'ul',
  'var',
]

const SHARED_ATTRIBUTES = [
  'abbr',
  'accept',
  'accept-charset',
  'accesskey',
  'action',
  'align',
  'alt',
  'axis',
  'border',
  'cellpadding',
  'cellspacing',
  'char',
  'charoff',
  'charset',
  'checked',
  'clear',
  'colspan',
  'color',
  'cols',
  'compact',
  'coords',
  'datetime',
  'dir',
  'enctype',
  'frame',
  'hspace',
  'headers',
  'height',
  'hreflang',
  'for',
  'id',
  'ismap',
  'itemprop',
  'label',
  'lang',
  'maxlength',
  'media',
  'method',
  'multiple',
  'name',
  'nohref',
  'noshade',
  'nowrap',
  'open',
  'prompt',
  'readonly',
  'rev',
  'rowspan',
  'rows',
  'rules',
  'scope',
  'selected',
  'shape',
  'size',
  'span',
  'start',
  'summary',
  'tabindex',
  'title',
  'usemap',
  'valign',
  'value',
  'width',
]

const ARIA = ['aria-describedby', 'aria-label', 'aria-labelledby']

const TAG_ATTRIBUTES: Record<string, string[]> = {
  a: [...ARIA, 'data-footnote-backref', 'data-footnote-ref', 'class', 'href'],
  blockquote: ['cite'],
  code: ['class'],
  del: ['cite'],
  div: ['itemscope', 'itemtype'],
  dl: ARIA,
  h2: ['class'],
  img: [...ARIA, 'longdesc', 'src'],
  input: ['disabled', 'type'],
  ins: ['cite'],
  li: ['class'],
  ol: [...ARIA, 'class'],
  q: ['cite'],
  section: ['data-footnotes', 'class'],
  source: ['srcset'],
  summary: ARIA,
  sup: ['class'],
  table: ARIA,
  ul: [...ARIA, 'class'],
}

const CLASSES: Record<string, RegExp> = {
  a: /^(data-footnote-backref|footnote-backref)$/,
  code: /^language-./,
  h2: /^sr-only$/,
  li: /^task-list-item$/,
  ol: /^contains-task-list$/,
  section: /^footnotes$/,
  sup: /^footnote-ref$/,
  ul: /^contains-task-list$/,
}

const ALERTS: Record<string, { icon: string; path: string }> = {
  note: {
    icon: 'octicon-info',
    path: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  },
  tip: {
    icon: 'octicon-light-bulb',
    path: 'M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z',
  },
  important: {
    icon: 'octicon-report',
    path: 'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  warning: {
    icon: 'octicon-alert',
    path: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  caution: {
    icon: 'octicon-stop',
    path: 'M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  },
}

const MARKDOWN_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'code',
  'img',
  'input',
  'sup',
  'section',
])

let purifier: ReturnType<typeof DOMPurify> | null = null

function sanitizer() {
  if (purifier != null) return purifier
  purifier = DOMPurify(window)
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName.toLowerCase()
    if (
      !SHARED_ATTRIBUTES.includes(data.attrName) &&
      !TAG_ATTRIBUTES[tag]?.includes(data.attrName)
    ) {
      data.keepAttr = false
    } else if (data.attrName === 'class') {
      const allowed = data.attrValue.split(/\s+/).filter((name) => CLASSES[tag]?.test(name))
      if (allowed.length === 0) data.keepAttr = false
      else data.attrValue = allowed.join(' ')
    }
  })
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'INPUT') {
      node.setAttribute('disabled', '')
      node.setAttribute('type', 'checkbox')
    }
  })
  return purifier
}

function isSafeLink(value: string): boolean {
  if (value.startsWith('//')) return false
  if (value.startsWith('#')) return true
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return !/^[a-z][a-z\d+.-]*:/i.test(value)
  }
}

export function resolveRepositoryPath(source: string, documentPath: string): string | null {
  if (
    source === '' ||
    source.startsWith('#') ||
    source.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(source)
  ) {
    return null
  }
  const pathname = source.split(/[?#]/, 1)[0]!
  const base = pathname.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  const resolved = [...base]
  for (const part of pathname.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  if (resolved.length === 0 || resolved.some((part) => part === '.git')) return null
  return resolved.join('/')
}

function resolveImage(source: string, documentPath: string): string | null {
  const path = resolveRepositoryPath(source, documentPath)
  if (path != null) return `api/v1/content?path=${encodeURIComponent(path)}`
  try {
    return new URL(source).protocol === 'https:' ? source : null
  } catch {
    return null
  }
}

function resolveSrcSet(srcSet: string, documentPath: string): string | null {
  const candidates = srcSet.split(',').flatMap((candidate) => {
    const [source = '', ...descriptors] = candidate.trim().split(/\s+/)
    const resolved = resolveImage(source, documentPath)
    return resolved == null ? [] : [[resolved, ...descriptors].join(' ')]
  })
  return candidates.length === 0 ? null : candidates.join(', ')
}

function alert(blockquote: Element): Element | null {
  const head = blockquote.firstElementChild
  const text = head?.firstChild
  if (head?.tagName !== 'P' || text?.nodeType !== Node.TEXT_NODE) return null
  const match = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i.exec(text.textContent!)
  if (match == null) return null
  const name = match[1]!.toLowerCase()
  text.textContent = text.textContent!.slice(match[0].length)
  if (head.textContent!.trim() === '' && head.children.length === 0) {
    if (head.nextElementSibling == null) return null
    head.remove()
  }
  const { icon, path } = ALERTS[name]!
  const document = blockquote.ownerDocument
  const box = document.createElement('div')
  box.className = `markdown-alert markdown-alert-${name}`
  const title = document.createElement('p')
  title.className = 'markdown-alert-title'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', `octicon ${icon} mr-2`)
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  shape.setAttribute('d', path)
  svg.append(shape)
  title.append(svg, name[0]!.toUpperCase() + name.slice(1))
  box.append(title, ...blockquote.childNodes)
  return box
}

function fence(code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(longest + 1)
}

function codeBlock(pre: Element, renderer: ReturnType<typeof createHtmlRenderer>): Element | null {
  const code = pre.firstElementChild
  if (code?.tagName !== 'CODE' || pre.childNodes.length !== 1) return null
  const language = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? ''
  const source = code.textContent ?? ''
  const marker = fence(source)
  const template = pre.ownerDocument.createElement('template')
  template.innerHTML = renderer.render(
    `${marker}${language}\n${source.endsWith('\n') ? source : `${source}\n`}${marker}\n`,
    false,
  ).html
  return template.content.firstElementChild
}

export function renderMarkdownPreview(
  source: string,
  documentPath: string,
  theme: Pick<MarkdownTheme, 'plugin' | 'scheme'>,
): DocumentFragment {
  const html = new TextDecoder().decode(renderToHtml(source))
  const fragment = sanitizer().sanitize(html, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: [...new Set([...SHARED_ATTRIBUTES, ...Object.values(TAG_ATTRIBUTES).flat()])],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ircs?|mailto|xmpp):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  })

  for (const blockquote of [...fragment.children].filter((node) => node.tagName === 'BLOCKQUOTE')) {
    const replacement = alert(blockquote)
    if (replacement != null) blockquote.replaceWith(replacement)
  }
  for (const element of fragment.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase()
    if (MARKDOWN_TAGS.has(tag) && !(tag === 'code' && element.parentElement?.tagName === 'PRE')) {
      element.setAttribute('data-markdown', tag)
    }
  }
  for (const link of fragment.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')!
    if (!isSafeLink(href)) {
      link.removeAttribute('href')
    } else if (href.startsWith('#')) {
      if (!href.startsWith(`#${PREFIX}`)) link.setAttribute('href', `#${PREFIX}${href.slice(1)}`)
    } else if (/^https?:/i.test(href)) {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noreferrer noopener')
    }
  }
  for (const sourceElement of fragment.querySelectorAll('source[media]')) {
    const scheme = /prefers-color-scheme\s*:\s*(light|dark)/i.exec(
      sourceElement.getAttribute('media')!,
    )?.[1]
    if (scheme == null) continue
    if (scheme.toLowerCase() === theme.scheme) sourceElement.removeAttribute('media')
    else sourceElement.remove()
  }
  for (const image of fragment.querySelectorAll('img')) {
    const mode = /#gh-(light|dark)-mode-only$/.exec(image.getAttribute('src') ?? '')?.[1]
    if (mode != null && mode !== theme.scheme) {
      image.remove()
      continue
    }
    const src = resolveImage(image.getAttribute('src') ?? '', documentPath)
    if (src == null) {
      const blocked = fragment.ownerDocument.createElement('span')
      blocked.className = 'rounded border px-2 py-1 text-xs text-muted-foreground'
      blocked.textContent = `Blocked image resource: ${image.getAttribute('alt') || 'unnamed'}`
      image.replaceWith(blocked)
    } else {
      image.setAttribute('src', src)
      image.setAttribute('loading', 'lazy')
    }
  }
  for (const sourceElement of fragment.querySelectorAll('source')) {
    const srcSet = resolveSrcSet(sourceElement.getAttribute('srcset') ?? '', documentPath)
    if (srcSet == null) sourceElement.remove()
    else sourceElement.setAttribute('srcset', srcSet)
  }
  const renderer = createHtmlRenderer({
    lineNumbers: false,
    controls: { code: { copy: true, download: false } },
    plugins: theme.plugin == null ? undefined : { code: theme.plugin },
  })
  try {
    for (const pre of fragment.querySelectorAll('pre')) {
      const replacement = codeBlock(pre, renderer)
      if (replacement != null) pre.replaceWith(replacement)
    }
  } finally {
    renderer.dispose()
  }

  const blocks = [...fragment.children]
  const lines = blockSourceLines(
    blocks.map((block) => /^H[1-6]$/.test(block.tagName)),
    source,
  )
  blocks.forEach((block, index) => block.setAttribute('data-source-line', `${lines[index]}`))
  return fragment
}
