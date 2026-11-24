export interface PaletteFileMatchParts {
  name: ReadonlySet<number>
  parent: ReadonlySet<number>
}

export function splitPaletteFileMatchIndices(
  path: string,
  name: string,
  parent: string,
  matchIndices: readonly number[],
): PaletteFileMatchParts {
  const pathLength = Array.from(path).length
  const nameLength = Array.from(name).length
  const parentLength = Array.from(parent).length
  const nameStart = pathLength - nameLength
  const nameMatches = new Set<number>()
  const parentMatches = new Set<number>()
  for (const index of matchIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= pathLength) continue
    if (index >= nameStart) {
      nameMatches.add(index - nameStart)
    } else if (index < parentLength || (parent !== '' && index === parentLength)) {
      // The rendered parent includes the path separator that is absent from
      // the parent field, so preserve an authoritative separator match.
      parentMatches.add(index)
    }
  }
  return { name: nameMatches, parent: parentMatches }
}

export function paletteTextMatches(value: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (normalizedQuery === '') return true
  const normalizedValue = value.toLocaleLowerCase()
  if (normalizedValue.includes(normalizedQuery)) return true
  const initials = normalizedValue
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
  return initials.includes(normalizedQuery.replace(/\s+/g, ''))
}
