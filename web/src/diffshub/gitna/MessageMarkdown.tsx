import { useMemo } from 'react'
import { Markdown } from '@pierre/words/react'
import { useMarkdownTheme } from './markdownTheme'

const components = {
  a: (html: string) => html.replace('<a ', '<a target="_blank" rel="noreferrer noopener" '),
}

export function MessageMarkdown({ body, live = false }: { body: string; live?: boolean }) {
  const highlighter = useMarkdownTheme()
  const plugins = useMemo(
    () => (highlighter?.plugin == null ? {} : { code: highlighter.plugin }),
    [highlighter],
  )
  return (
    <Markdown
      key={highlighter?.name}
      className="markdown-message"
      mode={live ? 'streaming' : 'static'}
      isAnimating={live}
      components={components}
      plugins={plugins}
      lineNumbers={false}
      controls={false}
    >
      {body}
    </Markdown>
  )
}
