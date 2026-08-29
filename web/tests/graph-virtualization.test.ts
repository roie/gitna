import { describe, expect, it } from 'vitest'

import { graphRangeExtractor, nextGraphFocusIndex } from '../src/diffshub/gitna/graphVirtualization'

describe('Graph virtualization', () => {
  it('keeps focused and portal-owning rows mounted outside the visible range', () => {
    expect(
      graphRangeExtractor({ count: 600, endIndex: 19, overscan: 3, startIndex: 10 }, [0, 11, 500]),
    ).toEqual([0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 500])
  })

  it('moves disclosure focus without wrapping beyond loaded history', () => {
    expect(nextGraphFocusIndex(10, 'ArrowDown', 600)).toBe(11)
    expect(nextGraphFocusIndex(10, 'ArrowUp', 600)).toBe(9)
    expect(nextGraphFocusIndex(10, 'Home', 600)).toBe(0)
    expect(nextGraphFocusIndex(10, 'End', 600)).toBe(599)
    expect(nextGraphFocusIndex(0, 'ArrowUp', 600)).toBe(0)
    expect(nextGraphFocusIndex(599, 'ArrowDown', 600)).toBe(599)
    expect(nextGraphFocusIndex(10, 'PageDown', 600)).toBeNull()
    expect(nextGraphFocusIndex(0, 'Home', 0)).toBeNull()
  })
})
