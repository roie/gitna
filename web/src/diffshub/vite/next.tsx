import type { AnchorHTMLAttributes, ReactNode } from 'react'

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode
  href: string
}

/** Vite boundary for the donor's client-only next/link usage. */
export default function Link({ children, href, ...props }: LinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  )
}

/** Vite boundary for the donor's client-only next/navigation usage. */
export function useRouter() {
  return {
    push(href: string) {
      window.history.pushState(null, '', href)
      window.dispatchEvent(new PopStateEvent('popstate'))
    },
  }
}
