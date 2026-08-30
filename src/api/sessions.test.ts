import { describe, it, expect, vi, beforeEach } from 'vitest'

// A minimal stand-in for supabase-js's chainable, thenable query builder —
// enough to cover the chain shapes src/api/sessions.ts actually uses
// (.select/.eq/.gte/.lt/.limit/.order, awaited at any point in the chain).
// This is deliberately not a full mock of the client: the goal is catching
// "this function queries the wrong table/column" regressions (exactly the
// class of mistake a rename like owner_pub -> owner_tag or
// messages -> session_log could introduce), not re-testing supabase-js itself.
function makeQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (resolve: (value: typeof result) => void) => resolve(result),
  }
  return builder
}

const fromMock = vi.fn()

vi.mock('./supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}))

beforeEach(() => {
  fromMock.mockReset()
})

describe('fetchMessagesInRange', () => {
  it('queries the messages table (update this string when the session_log rename lands)', async () => {
    const { fetchMessagesInRange } = await import('./sessions')
    const rows = [{ id: '1', session_id: 's', ciphertext: 'c', iv: 'i', created_at: 'now' }]
    fromMock.mockReturnValue(makeQueryBuilder({ data: rows, error: null }))

    const result = await fetchMessagesInRange('s', '2026-01-01T00:00:00.000Z', null)

    expect(fromMock).toHaveBeenCalledWith('messages')
    expect(result).toEqual(rows)
  })

  it('returns an empty array on a query error rather than throwing', async () => {
    const { fetchMessagesInRange } = await import('./sessions')
    fromMock.mockReturnValue(makeQueryBuilder({ data: null, error: { message: 'boom' } }))

    const result = await fetchMessagesInRange('s', '2026-01-01T00:00:00.000Z', null)
    expect(result).toEqual([])
  })
})

describe('hasMessagesBefore', () => {
  it('is true when the existence check finds a row', async () => {
    const { hasMessagesBefore } = await import('./sessions')
    fromMock.mockReturnValue(makeQueryBuilder({ data: [{ id: '1' }], error: null }))

    expect(await hasMessagesBefore('s', '2026-01-01T00:00:00.000Z')).toBe(true)
    expect(fromMock).toHaveBeenCalledWith('messages')
  })

  it('is false when nothing comes back', async () => {
    const { hasMessagesBefore } = await import('./sessions')
    fromMock.mockReturnValue(makeQueryBuilder({ data: [], error: null }))

    expect(await hasMessagesBefore('s', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('is false (not thrown) on a query error, same fail-safe as elsewhere', async () => {
    const { hasMessagesBefore } = await import('./sessions')
    fromMock.mockReturnValue(makeQueryBuilder({ data: null, error: { message: 'boom' } }))

    expect(await hasMessagesBefore('s', '2026-01-01T00:00:00.000Z')).toBe(false)
  })
})

describe('isJoinAccessExpired', () => {
  it('is not expired the moment it is created', async () => {
    const { isJoinAccessExpired } = await import('./sessions')
    expect(isJoinAccessExpired({ created_at: new Date().toISOString() })).toBe(false)
  })

  it('is not yet expired just under the 10-minute TTL', async () => {
    const { isJoinAccessExpired, JOIN_LINK_TTL_MS } = await import('./sessions')
    const created = new Date(Date.now() - (JOIN_LINK_TTL_MS - 1000)).toISOString()
    expect(isJoinAccessExpired({ created_at: created })).toBe(false)
  })

  it('is expired just past the 10-minute TTL', async () => {
    const { isJoinAccessExpired, JOIN_LINK_TTL_MS } = await import('./sessions')
    const created = new Date(Date.now() - (JOIN_LINK_TTL_MS + 1000)).toISOString()
    expect(isJoinAccessExpired({ created_at: created })).toBe(true)
  })
})
