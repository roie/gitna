import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { useEffect, useRef } from 'react'

const resolver = createFileTreeIconResolver('complete')
const spriteSheet = getBuiltInSpriteSheet('complete')

export function FileTypeIconSprite() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host == null) return
    const parsed = new DOMParser().parseFromString(spriteSheet, 'text/html')
    const sprites = [...parsed.body.children].filter(
      (element): element is SVGSVGElement => element.localName === 'svg',
    )
    if (sprites.length === 0) return
    for (const sprite of sprites) {
      for (const element of sprite.querySelectorAll('script, foreignObject')) element.remove()
      for (const element of sprite.querySelectorAll('*')) {
        for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
          const attribute = element.attributes.item(index)
          if (attribute?.name.toLowerCase().startsWith('on'))
            element.removeAttribute(attribute.name)
        }
      }
    }
    host.replaceChildren(...sprites.map((sprite) => document.importNode(sprite, true)))
    return () => host.replaceChildren()
  }, [])
  return <div ref={hostRef} aria-hidden="true" className="absolute size-0 overflow-hidden" />
}

export function FileTypeIcon({ path, palette = false }: { path: string; palette?: boolean }) {
  const icon = resolver.resolveIcon('file-tree-icon-file', path)
  return (
    <svg
      aria-hidden="true"
      data-palette-file-icon={palette || undefined}
      data-icon-name={icon.name}
      data-icon-token={icon.token}
      viewBox={icon.viewBox ?? `0 0 ${String(icon.width ?? 16)} ${String(icon.height ?? 16)}`}
      width={icon.width ?? 16}
      height={icon.height ?? 16}
      className="size-4 shrink-0"
      style={
        icon.token == null
          ? undefined
          : {
              color: `var(--trees-file-icon-color-${icon.token}, var(--trees-file-icon-color, currentColor))`,
            }
      }
    >
      <use href={`#${icon.name.replace(/^#/, '')}`} />
    </svg>
  )
}
