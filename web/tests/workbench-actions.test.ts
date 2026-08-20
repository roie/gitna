import { describe, expect, it, vi } from 'vitest'
import { shortcutAction, WorkbenchActions } from '../src/lib/workbench-actions'

function key(
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) {
  return {
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe('WorkbenchActions', () => {
  it('maps the shared daily-workflow shortcuts', () => {
    expect(shortcutAction(key('ArrowDown', { altKey: true }))).toBe('next-file')
    expect(shortcutAction(key('ArrowUp', { altKey: true }))).toBe('previous-file')
    expect(shortcutAction(key('g', { ctrlKey: true, shiftKey: true }))).toBe('focus-source-control')
    expect(shortcutAction(key('c', { metaKey: true, shiftKey: true }))).toBe('focus-commit')
    expect(shortcutAction(key('s', { ctrlKey: true, shiftKey: true }))).toBe('stage-toggle')
    expect(shortcutAction(key('l', { ctrlKey: true, shiftKey: true }))).toBe('toggle-layout')
    expect(shortcutAction(key('Enter', { ctrlKey: true }))).toBe('commit')
    expect(shortcutAction(key('F5'))).toBe('refresh')
    expect(shortcutAction(key('F6'))).toBe('focus-changes')
    expect(shortcutAction(key('F6', { shiftKey: true }))).toBe('focus-graph')
    expect(shortcutAction(key('F1'))).toBe('action-menu')
  })

  it('registers one owner per action and removes only the current owner', () => {
    const actions = new WorkbenchActions()
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = actions.register('refresh', first)
    const disposeSecond = actions.register('refresh', second)

    disposeFirst()
    expect(actions.run('refresh')).toBe(true)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()

    disposeSecond()
    expect(actions.run('refresh')).toBe(false)
  })
})
