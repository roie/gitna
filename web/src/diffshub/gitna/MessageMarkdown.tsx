import { useMemo } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { parseMarkdown } from './markdownParser'

export function MessageMarkdown({ body }: { body: string }) {
  const rendered = useMemo(
    () =>
      toJsxRuntime(parseMarkdown(body), {
        Fragment,
        jsx,
        jsxs,
        components: {
          a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        },
      }),
    [body],
  )
  return <div className="markdown-preview markdown-message">{rendered}</div>
}
