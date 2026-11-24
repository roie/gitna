import type { FileContents } from '@pierre/diffs'
import {
  IconBranch,
  IconCheck,
  IconDiffSplit,
  IconFolder,
  IconFolderOpen,
  IconHome,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconThemes,
  IconX,
} from '@pierre/icons'
import type { ColorMode } from '@pierre/theming'
import { createElement, type Dispatch, type SetStateAction } from 'react'
import type { GitnaPaletteCommand } from '../features/command-palette/command-palette'
import type { MarkdownViewMode } from '../features/viewer/preview/markdown-preview'
import type { ReviewRequest } from '../lib/api'
import { ActionGuardError, type GitnaRepository } from '../repository/repository'

type DiffStyle = 'split' | 'unified'

export function buildPaletteCommands({
  backendDisabledReason,
  colorMode,
  diffStyle,
  fileTreeOverlayOpen,
  mobileViewport,
  openFindInFiles,
  openFolderDisabledReason,
  openHome,
  previewLabel,
  previewMode,
  previewPath,
  repository,
  requestFolderSwitch,
  saveWorktreeFile,
  setColorMode,
  setDiffStyle,
  setPendingUntitledSaveAs,
  setPreviewMode,
  setSidebarMode,
  sidebarVisible,
  target,
  toggleSidebar,
  worktreeDrafts,
}: {
  backendDisabledReason: string | null
  colorMode: ColorMode
  diffStyle: DiffStyle
  fileTreeOverlayOpen: boolean
  mobileViewport: boolean
  openFindInFiles: () => void
  openFolderDisabledReason: string | null
  openHome: () => void
  previewLabel: string
  previewMode: MarkdownViewMode
  previewPath: string | null
  repository: GitnaRepository
  requestFolderSwitch: (path: string, returnHome: boolean) => Promise<void>
  saveWorktreeFile: (path: string) => Promise<boolean>
  setColorMode: (mode: ColorMode) => void
  setDiffStyle: Dispatch<SetStateAction<DiffStyle>>
  setPendingUntitledSaveAs: (path: string) => void
  setPreviewMode: (mode: MarkdownViewMode) => void
  setSidebarMode: (mode: 'source') => void
  sidebarVisible: boolean
  target: { filePath?: string; request?: ReviewRequest; selectedPath?: string } | null
  toggleSidebar: () => void
  worktreeDrafts: ReadonlyMap<string, FileContents>
}): GitnaPaletteCommand[] {
  const commands: GitnaPaletteCommand[] = [
    {
      id: 'search-commits',
      icon: createElement(IconBranch),
      label: 'Search Commits…',
      description: 'Search history by message, author, or hash',
      keywords: 'git history log',
      paletteQuery: '#',
      disabledReason: repository.snapshot?.repository
        ? backendDisabledReason
        : 'Open a Git repository to search commits.',
      run: () => {},
    },
    {
      id: 'find-in-files',
      icon: createElement(IconSearch),
      label: 'Find in Files',
      description: 'Search text across the current folder',
      keywords: 'search workspace files content',
      run: openFindInFiles,
    },
    {
      id: 'open-folder',
      icon: createElement(IconFolderOpen),
      label: 'Open Folder',
      description: 'Enter an absolute local folder path',
      keywords: 'switch location path',
      disabledReason: openFolderDisabledReason,
      run() {
        if (repository.getActionDisabledReason('open-folder') != null) return
        openHome()
        window.setTimeout(
          () => document.querySelector<HTMLInputElement>('[aria-label="Folder path"]')?.focus(),
          0,
        )
      },
    },
    {
      id: 'home',
      icon: createElement(IconHome),
      label: 'Gitna Home',
      description: 'Open folders and recent history',
      keywords: 'welcome recent',
      run: openHome,
    },
    {
      id: 'refresh',
      icon: createElement(IconRefresh),
      label: 'Refresh',
      description: 'Refresh the current folder',
      keywords: 'reload repository explorer graph',
      run: () => repository.refreshCurrentFolder(),
    },
    {
      id: 'new-file',
      icon: createElement(IconPlus),
      label: 'New File',
      description: 'Create an untitled file in memory',
      keywords: 'untitled document buffer',
      run: () => repository.createUntitledDocument(),
    },
    {
      id: 'show-source-control',
      icon: createElement(IconSidebar),
      label: 'Show Source Control',
      description: 'Switch the sidebar back to Source Control',
      keywords: 'source control changes git',
      run: () => setSidebarMode('source'),
    },
    {
      id: 'toggle-sidebar',
      icon: createElement(IconSidebar),
      label: 'Toggle Sidebar',
      description: (mobileViewport ? fileTreeOverlayOpen : sidebarVisible)
        ? 'Hide Source Control'
        : 'Show Source Control',
      keywords: 'source control explorer',
      run: toggleSidebar,
    },
    {
      id: 'toggle-diff-layout',
      icon: createElement(IconDiffSplit),
      label: 'Toggle Diff Layout',
      description: diffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view',
      keywords: 'split unified view',
      run: () => setDiffStyle((style) => (style === 'split' ? 'unified' : 'split')),
    },
    {
      id: 'change-theme',
      icon: createElement(IconThemes),
      label: 'Change Theme',
      description:
        colorMode === 'system'
          ? 'Use light theme'
          : colorMode === 'light'
            ? 'Use dark theme'
            : 'Follow system theme',
      keywords: 'appearance light dark system color',
      run: () =>
        setColorMode(colorMode === 'system' ? 'light' : colorMode === 'light' ? 'dark' : 'system'),
    },
  ]

  if (previewPath != null) {
    commands.push(
      {
        id: 'file-preview',
        icon: createElement(IconDiffSplit),
        label: `${previewLabel}: Open Preview`,
        description: `Show the rendered ${previewLabel} in the current pane`,
        keywords: `${previewLabel} preview render`,
        run: () => setPreviewMode('preview'),
      },
      {
        id: 'file-preview-side',
        icon: createElement(IconDiffSplit),
        label: `${previewLabel}: Open Preview to the Side`,
        description: 'Keep the editor open beside the rendered preview',
        keywords: `${previewLabel} preview split side`,
        run: () => setPreviewMode('split'),
      },
    )
    if (previewMode !== 'editor') {
      commands.push({
        id: 'file-close-preview',
        icon: createElement(IconX),
        label: `${previewLabel}: Close Preview`,
        description: `Return to the ${previewLabel} editor`,
        keywords: `${previewLabel} preview close editor`,
        run: () => setPreviewMode('editor'),
      })
    }
  }

  const currentPath =
    target?.filePath ??
    (target?.request?.scope === 'staged' || target?.request?.scope === 'unstaged'
      ? target.selectedPath
      : undefined)
  if (
    currentPath != null &&
    (worktreeDrafts.has(currentPath) || repository.isUntitledPath(currentPath))
  ) {
    commands.push({
      id: 'save-file',
      icon: createElement(IconCheck),
      label: 'Save File',
      description: currentPath,
      keywords: 'write dirty changes',
      disabledReason: backendDisabledReason,
      run: async () => {
        if (repository.isUntitledPath(currentPath)) {
          setPendingUntitledSaveAs(currentPath)
          return
        }
        const saved = await saveWorktreeFile(currentPath)
        if (!saved) {
          const reason = repository.getActionDisabledReason()
          if (reason != null) throw new ActionGuardError(reason)
        }
      },
    })
  }
  const unstagedChange = repository.snapshot?.unstaged.find((change) => change.path === currentPath)
  if (unstagedChange != null) {
    commands.push({
      id: 'stage-file',
      icon: createElement(IconPlus),
      label: 'Stage Current File',
      description: unstagedChange.path,
      keywords: 'git add',
      disabledReason: backendDisabledReason,
      run: () =>
        repository.mutate({
          op: 'stage',
          paths: unstagedChange.oldPath
            ? [unstagedChange.oldPath, unstagedChange.path]
            : [unstagedChange.path],
        }),
    })
  }
  const stagedChange = repository.snapshot?.staged.find((change) => change.path === currentPath)
  if (stagedChange != null) {
    commands.push({
      id: 'unstage-file',
      icon: createElement(IconMinus),
      label: 'Unstage Current File',
      description: stagedChange.path,
      keywords: 'git reset index',
      disabledReason: backendDisabledReason,
      run: () =>
        repository.mutate({
          op: 'unstage',
          paths: stagedChange.oldPath
            ? [stagedChange.oldPath, stagedChange.path]
            : [stagedChange.path],
        }),
    })
  }
  for (const folder of repository.folders?.recent ?? []) {
    if (folder.path === repository.snapshot?.root) continue
    commands.push({
      id: `recent-folder:${folder.path}`,
      icon: createElement(IconFolder),
      label: `Open Recent Folder: ${folder.name}`,
      description: folder.path,
      keywords: 'recent history switch folder',
      disabledReason: openFolderDisabledReason,
      run: () => requestFolderSwitch(folder.path, false),
    })
  }
  for (const branch of repository.branches) {
    if (branch.current || branch.remote) continue
    commands.push({
      id: `switch-branch:${branch.name}`,
      icon: createElement(IconBranch),
      label: `Switch Branch: ${branch.name}`,
      description: branch.upstream ?? 'Local branch',
      keywords: 'git checkout branch',
      disabledReason: backendDisabledReason,
      run: () => repository.switchBranch(branch.name),
    })
  }
  return commands
}
