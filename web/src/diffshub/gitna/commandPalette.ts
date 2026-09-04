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
