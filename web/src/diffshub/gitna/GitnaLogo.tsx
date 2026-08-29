import { cn } from '@/lib/cn'

export function GitnaLogo({ className }: { className?: string }) {
  return (
    <span className={cn('relative block size-6 shrink-0', className)} role="img" aria-label="Gitna">
      <img
        src="./gitna-logo-light.png"
        alt=""
        aria-hidden="true"
        className="block size-full dark:hidden"
      />
      <img
        src="./gitna-logo-dark.png"
        alt=""
        aria-hidden="true"
        className="hidden size-full dark:block"
      />
    </span>
  )
}
