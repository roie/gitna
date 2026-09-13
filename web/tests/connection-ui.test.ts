import { describe, expect, it, vi } from 'vitest'

vi.mock('@pierre/icons', () => ({ IconRefresh: 'span' }))

import { connectionStatusDetails } from '../src/diffshub/gitna/ConnectionStatus'

describe('connection status presentation', () => {
  it('labels every recovery state and keeps connected chrome quiet', () => {
    expect(connectionStatusDetails('connecting', null, null, false).label).toBe(
      'Connecting to backend…',
    )
    expect(connectionStatusDetails('reconnecting', null, null, true).label).toBe('Reconnecting…')
    expect(connectionStatusDetails('reconciling', null, null, true).label).toBe(
      'Refreshing backend state…',
    )
    expect(connectionStatusDetails('unreachable', 'offline', null, true).details).toContain(
      'offline',
    )
    expect(connectionStatusDetails('session-error', '403', null, false).details).toContain('403')
    expect(connectionStatusDetails('connected', null, null, true)).toEqual({
      label: null,
      details: [],
    })
  })

  it('discloses freshness without inventing a timestamp', () => {
    const withoutTimestamp = connectionStatusDetails('reconnecting', null, null, true)
    expect(withoutTimestamp.details).toContain('Shown folder data is not yet verified.')
    expect(withoutTimestamp.details.some((detail) => detail.startsWith('Last refreshed'))).toBe(
      false,
    )
    const withTimestamp = connectionStatusDetails('reconnecting', null, 0, true)
    expect(withTimestamp.details.some((detail) => detail.startsWith('Last refreshed'))).toBe(true)
  })
})
