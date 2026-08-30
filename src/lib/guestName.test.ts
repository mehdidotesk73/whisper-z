import { describe, it, expect } from 'vitest'
import { guestNameForKey, truncateName } from './guestName'

describe('guestNameForKey', () => {
  it('is deterministic for the same key', () => {
    const key = 'someX.someY'
    expect(guestNameForKey(key)).toBe(guestNameForKey(key))
  })

  it('differs across different keys (in general)', () => {
    const names = new Set(['a.1', 'b.2', 'c.3', 'd.4', 'e.5'].map(guestNameForKey))
    expect(names.size).toBeGreaterThan(1)
  })

  it('always returns a Color+Noun+3-char-suffix shape', () => {
    const name = guestNameForKey('anyPublicKeyId.here')
    expect(name).toMatch(/^[A-Za-z]+[0-9A-Z]{3}$/)
  })
})

describe('truncateName', () => {
  it('leaves short names untouched', () => {
    expect(truncateName('BlueFox123')).toBe('BlueFox123')
  })

  it('truncates names over the display limit and appends an ellipsis', () => {
    const long = 'ThisUsernameIsDefinitelyWayTooLongToDisplay'
    const truncated = truncateName(long)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated.length).toBe(21) // 20 chars + ellipsis
  })

  it('does not truncate a name exactly at the limit', () => {
    const exact = 'a'.repeat(20)
    expect(truncateName(exact)).toBe(exact)
  })
})
