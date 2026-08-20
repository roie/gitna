export type WorkbenchAction =
  | 'next-file'
  | 'previous-file'
  | 'stage-toggle'
  | 'focus-commit'
  | 'commit'
  | 'refresh'
  | 'focus-changes'
  | 'focus-graph'
  | 'toggle-layout'
  | 'action-menu'
  | 'focus-source-control'

export type WorkbenchActionHandler = () => void

/** Shared command surface for mouse menus and keyboard shortcuts. Components
 * register only the commands they own; App owns the single keydown listener. */
export class WorkbenchActions {
  private readonly handlers = new Map<WorkbenchAction, WorkbenchActionHandler>()

  register(action: WorkbenchAction, handler: WorkbenchActionHandler): () => void {
    this.handlers.set(action, handler)
    return () => {
      if (this.handlers.get(action) === handler) this.handlers.delete(action)
    }
  }

  run(action: WorkbenchAction): boolean {
    const handler = this.handlers.get(action)
    if (!handler) return false
    handler()
    return true
  }

  handleKeydown(event: KeyboardEvent): void {
    const action = shortcutAction(event)
    if (!action || !this.run(action)) return
    event.preventDefault()
    event.stopPropagation()
  }
}

export function shortcutAction(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): WorkbenchAction | null {
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()

  if (event.altKey && !command && key === 'arrowdown') return 'next-file'
  if (event.altKey && !command && key === 'arrowup') return 'previous-file'
  if (command && event.shiftKey && key === 'g') return 'focus-source-control'
  if (command && event.shiftKey && key === 'c') return 'focus-commit'
  if (command && event.shiftKey && key === 's') return 'stage-toggle'
  if (command && event.shiftKey && key === 'l') return 'toggle-layout'
  if (command && !event.shiftKey && key === 'enter') return 'commit'
  if (!command && !event.altKey && key === 'f5') return 'refresh'
  if (!command && !event.altKey && key === 'f6')
    return event.shiftKey ? 'focus-graph' : 'focus-changes'
  if (!command && !event.altKey && key === 'f1') return 'action-menu'
  return null
}
