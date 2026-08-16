export interface HunkPatch {
  /** The full single-hunk patch: file header plus one @@ block, ending in a
   * trailing newline as git apply requires. */
  patch: string
  /** The raw @@ range line, e.g. "@@ -1,5 +1,5 @@" for display. */
  range: string
}

/**
 * Splits a unified diff patch into one standalone patch per hunk. Each output
 * patch keeps the file header (---/+++ lines and metadata) plus a single @@
 * block, which is the shape git apply accepts for partial staging. An empty
 * patch returns no hunks.
 */
export function splitHunkPatches(patch: string): HunkPatch[] {
  const lines = patch.split('\n')
  let i = 0
  const header: string[] = []
  for (; i < lines.length; i++) {
    if (lines[i]!.startsWith('@@')) break
    header.push(lines[i]!)
  }
  if (i === lines.length) return []

  const hunks: HunkPatch[] = []
  let current = header.slice()
  let range = lines[i]!
  for (; i < lines.length; i++) {
    if (lines[i]!.startsWith('@@') && current.length > header.length) {
      hunks.push({ patch: joinPatch(current), range })
      current = header.slice()
    }
    if (current.length === header.length && lines[i]!.startsWith('@@')) {
      range = lines[i]!
    }
    current.push(lines[i]!)
  }
  hunks.push({ patch: joinPatch(current), range })
  return hunks
}

function joinPatch(lines: string[]): string {
  let out = lines.join('\n')
  if (!out.endsWith('\n')) out += '\n'
  return out
}
