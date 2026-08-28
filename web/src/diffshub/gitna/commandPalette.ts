export const COMMAND_PALETTE_RESULT_LIMIT = 100

export interface RankedPaletteFile {
  duplicateName: boolean
  name: string
  parent: string
  path: string
  score: number
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

function fuzzyScore(value: string, query: string): number | null {
  let position = -1
  let gap = 0
  let run = 0
  let bestRun = 0
  for (const character of query) {
    const next = value.indexOf(character, position + 1)
    if (next < 0) return null
    if (next === position + 1) {
      run += 1
      bestRun = Math.max(bestRun, run)
    } else {
      gap += next - position - 1
      run = 1
    }
    position = next
  }
  return gap + position - bestRun * 2
}

function pathScore(path: string, query: string): number | null {
  if (query === '') return 400
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length > 1) {
    let total = 90
    for (const term of terms) {
      const score = pathScore(path, term)
      if (score == null) return null
      total += score
    }
    return total
  }
  const normalizedPath = path.toLocaleLowerCase()
  const name = basename(normalizedPath)
  if (name === query) return 0
  if (normalizedPath === query) return 1
  if (name.startsWith(query)) return 20 + name.length - query.length
  if (normalizedPath.startsWith(query)) return 40 + normalizedPath.length - query.length
  if (name.includes(query)) return 60 + name.indexOf(query)
  if (normalizedPath.includes(query)) return 80 + normalizedPath.indexOf(query)
  const fuzzy = fuzzyScore(normalizedPath, query)
  return fuzzy == null ? null : 120 + fuzzy
}

export function rankPaletteFiles(
  paths: readonly string[],
  query: string,
  openPaths: readonly string[],
  limit = COMMAND_PALETTE_RESULT_LIMIT,
): RankedPaletteFile[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const recency = new Map(openPaths.map((path, index) => [path, index + 1]))
  const names = new Map<string, number>()
  for (const path of paths) {
    const name = basename(path).toLocaleLowerCase()
    names.set(name, (names.get(name) ?? 0) + 1)
  }

  const ranked: RankedPaletteFile[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const relevance = pathScore(path, normalizedQuery)
    if (relevance == null) continue
    const recent = recency.get(path) ?? 0
    const name = basename(path)
    ranked.push({
      duplicateName: (names.get(name.toLocaleLowerCase()) ?? 0) > 1,
      name,
      parent: parentPath(path),
      path,
      score: relevance - Math.min(recent, 10),
    })
  }
  return ranked
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, Math.max(0, limit))
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
