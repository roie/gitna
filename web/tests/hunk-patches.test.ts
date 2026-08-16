import { describe, expect, it } from 'vitest'
import { splitHunkPatches } from '../src/lib/hunk-patches'

const header = `diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
`

const twoHunkDiff = `${header}@@ -1,5 +1,5 @@
 1
-2
+TWO
 3
 4
 5
@@ -27,7 +27,7 @@
 27
 28
 29
-30
+THIRTY
 31
 32
 33
`

describe('splitHunkPatches', () => {
  it('splits a multi-hunk patch into one standalone patch per hunk', () => {
    const hunks = splitHunkPatches(twoHunkDiff)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.range).toBe('@@ -1,5 +1,5 @@')
    expect(hunks[1]!.range).toBe('@@ -27,7 +27,7 @@')
  })

  it('keeps the file header on every hunk and isolates hunk bodies', () => {
    const [first, second] = splitHunkPatches(twoHunkDiff)
    for (const hunk of [first!, second!]) {
      expect(hunk.patch.startsWith(header)).toBe(true)
    }
    expect(first!.patch).toContain('+TWO')
    expect(first!.patch).not.toContain('+THIRTY')
    expect(second!.patch).toContain('+THIRTY')
    expect(second!.patch).not.toContain('+TWO')
  })

  it('ends every patch with a trailing newline for git apply', () => {
    for (const hunk of splitHunkPatches(twoHunkDiff)) {
      expect(hunk.patch.endsWith('\n')).toBe(true)
    }
  })

  it('returns a single hunk for a single-hunk patch', () => {
    const single = `${header}@@ -1,3 +1,3 @@
-one
+ONE
 two
 three
`
    const hunks = splitHunkPatches(single)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.patch).toBe(single)
  })

  it('returns no hunks for an empty or hunk-less patch', () => {
    expect(splitHunkPatches('')).toEqual([])
    expect(splitHunkPatches('diff --git a/x b/x\n')).toEqual([])
  })
})
