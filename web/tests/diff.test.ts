import { describe, expect, it } from 'vitest'
import { diffQuery } from '../src/lib/api'
import { toDiffSides } from '../src/lib/pierre-diff'
import type { ChangeKind, FileDiff } from '../src/lib/types'

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    before: { path: 'a.txt', content: 'one\n' },
    after: { path: 'a.txt', content: 'one\ntwo\n' },
    binary: false,
    tooLarge: false,
    ...overrides,
  }
}

describe('diffQuery', () => {
  it('encodes scope and path', () => {
    expect(diffQuery({ scope: 'unstaged', path: 'dir/file.txt' })).toBe(
      'scope=unstaged&path=dir%2Ffile.txt',
    )
  })

  it('omits oldPath when absent', () => {
    expect(diffQuery({ scope: 'staged', path: 'a.txt' })).not.toContain('oldPath')
  })

  it('adds oldPath for renames', () => {
    expect(diffQuery({ scope: 'staged', path: 'new.txt', oldPath: 'old.txt' })).toBe(
      'scope=staged&path=new.txt&oldPath=old.txt',
    )
  })
})

describe('toDiffSides', () => {
  it('passes both sides for a modified file', () => {
    const { oldFile, newFile } = toDiffSides(fileDiff(), 'modified')
    expect(oldFile?.name).toBe('a.txt')
    expect(oldFile?.contents).toBe('one\n')
    expect(newFile?.contents).toBe('one\ntwo\n')
  })

  it('drops the before side for added and untracked files', () => {
    for (const kind of ['added', 'untracked'] as ChangeKind[]) {
      const { oldFile, newFile } = toDiffSides(fileDiff({ before: { path: 'a.txt', content: '' } }), kind)
      expect(oldFile).toBeNull()
      expect(newFile?.name).toBe('a.txt')
    }
  })

  it('drops the after side for deleted files', () => {
    const { oldFile, newFile } = toDiffSides(fileDiff({ after: { path: 'a.txt', content: '' } }), 'deleted')
    expect(oldFile?.contents).toBe('one\n')
    expect(newFile).toBeNull()
  })

  it('keeps both sides for renames', () => {
    const diff = fileDiff({
      before: { path: 'old.txt', content: 'same\n' },
      after: { path: 'new.txt', content: 'same\n' },
    })
    const { oldFile, newFile } = toDiffSides(diff, 'renamed')
    expect(oldFile?.name).toBe('old.txt')
    expect(newFile?.name).toBe('new.txt')
  })

  it('forwards the server language hint onto both sides', () => {
    const diff = fileDiff({
      before: { path: 'a.go', language: 'go', content: 'one\n' },
      after: { path: 'a.go', language: 'go', content: 'two\n' },
    })
    const { oldFile, newFile } = toDiffSides(diff, 'modified')
    expect(oldFile?.lang).toBe('go')
    expect(newFile?.lang).toBe('go')
  })

  it('leaves lang undefined when the server does not know it', () => {
    const { newFile } = toDiffSides(fileDiff(), 'modified')
    expect('lang' in newFile!).toBe(false)
  })
})
