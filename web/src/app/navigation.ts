export function isHomePath(pathname: string): boolean {
  return /^\/(?:g\/[^/]+\/)?$/.test(pathname)
}

export function resolveFolderHref(href: string, folderURL: string): URL {
  if (isHomePath(new URL(folderURL).pathname) && href.startsWith('../')) {
    href = href.slice(3)
  }
  return new URL(href, folderURL)
}
