import { describe, expect, it } from 'vitest'
import { DocumentStore } from '../src/diffshub/gitna/documents'

describe('DocumentStore', () => {
  it('gives identical untitled contents distinct stable identities and labels', () => {
    const store = new DocumentStore()
    const first = store.createUntitled('same text')
    const second = store.createUntitled('same text')

    expect(first.id).not.toBe(second.id)
    expect(first.label).toBe('Untitled-1')
    expect(second.label).toBe('Untitled-2')
    expect(first.path).toBeUndefined()
    expect(first.dirty).toBe(false)
  })

  it('tracks dirty state by content baseline, including undo to the baseline', () => {
    const store = new DocumentStore()
    const created = store.createUntitled()

    const edited = store.updateContent(created.id, 'draft')
    expect(edited.revision).toBe(1)
    expect(edited.dirty).toBe(true)

    const undone = store.updateContent(created.id, '')
    expect(undone.revision).toBe(2)
    expect(undone.dirty).toBe(false)
    expect(undone.saveState).toBe('clean')
  })

  it('keeps newer edits dirty when an older save completes', () => {
    const store = new DocumentStore()
    const created = store.createUntitled()
    const firstEdit = store.updateContent(created.id, 'first')
    store.beginSave(created.id)
    const newerEdit = store.updateContent(created.id, 'second')

    const acknowledged = store.acknowledgeSave(created.id, firstEdit.revision, 'first', {
      path: 'notes.txt',
      baselineHash: 'hash-1',
    })

    expect(acknowledged.id).toBe(created.id)
    expect(acknowledged.path).toBe('notes.txt')
    expect(acknowledged.contents).toBe(newerEdit.contents)
    expect(acknowledged.savedRevision).toBe(firstEdit.revision)
    expect(acknowledged.dirty).toBe(true)
    expect(acknowledged.saveState).toBe('dirty')
  })

  it('preserves document identity and content through Save As binding', () => {
    const store = new DocumentStore()
    const created = store.createUntitled('draft')
    const bound = store.acknowledgeSave(created.id, created.revision, 'draft', {
      path: 'src/notes.txt',
      baselineHash: 'hash-2',
    })

    expect(bound.id).toBe(created.id)
    expect(bound.path).toBe('src/notes.txt')
    expect(bound.label).toBe('notes.txt')
    expect(bound.dirty).toBe(false)
    expect(bound.baselineHash).toBe('hash-2')
  })

  it('rejects acknowledgements for revisions that do not exist', () => {
    const store = new DocumentStore()
    const created = store.createUntitled()

    expect(() => store.acknowledgeSave(created.id, 1, '')).toThrow('future revision')
  })
})
