import { GitnaLogo } from './GitnaLogo'

export function folderDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function FolderLoadingScreen({ path }: { path: string }) {
  const name = folderDisplayName(path)
  return (
    <main
      aria-busy="true"
      aria-labelledby="folder-loading-title"
      className="fixed inset-0 z-[100] grid min-h-dvh place-items-center bg-background px-6 text-foreground"
      data-folder-loading
    >
      <div className="flex min-w-0 max-w-full flex-col items-center text-center">
        <div className="flex items-center gap-2.5 text-base font-semibold">
          <GitnaLogo className="size-10" />
          <span>Gitna</span>
        </div>
        <h1
          id="folder-loading-title"
          className="mt-5 max-w-[min(28rem,calc(100vw-3rem))] truncate text-lg font-semibold"
          title={`Opening ${name}`}
        >
          Opening {name}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground" role="status">
          Preparing your folder…
        </p>
        <span
          aria-hidden="true"
          className="mt-5 size-[18px] animate-spin rounded-full border-2 border-border border-t-foreground motion-reduce:animate-none"
        />
      </div>
    </main>
  )
}
