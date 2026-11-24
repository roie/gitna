import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'

export function graphRangeExtractor(range: Range, pinnedIndices: readonly number[]): number[] {
  return [...new Set([...defaultRangeExtractor(range), ...pinnedIndices])].sort((a, b) => a - b)
}

export function shouldLoadMoreGraph(
  lastVisible: number,
  rowCount: number,
  threshold = 10,
): boolean {
  return rowCount > 0 && lastVisible >= Math.max(0, rowCount - threshold)
}

export function nextGraphFocusIndex(index: number, key: string, count: number): number | null {
  if (count === 0) return null
  if (key === 'ArrowDown') return Math.min(index + 1, count - 1)
  if (key === 'ArrowUp') return Math.max(index - 1, 0)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
