import { describe, expect, it } from 'vitest'
import { diffQuery } from '../src/lib/api'

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
