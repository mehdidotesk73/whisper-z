// @vitest-environment jsdom
//
// route.ts reads window.location.hash and registers a hashchange listener
// at module load time, so importing it at all needs a `window` to exist —
// hence jsdom here while everything else in src/lib/ stays on the faster
// plain-Node environment.
import { describe, it, expect } from 'vitest'
import {
  parseHash,
  extractHash,
  extractAccountKey,
  extractPackedKey,
  sessionHash,
  joinHash,
  mySessionHash,
  accountHash,
  homeHash,
} from './route'

describe('parseHash', () => {
  it('parses a join link', () => {
    expect(parseHash('#/join/abc-123/the-secret')).toEqual({
      name: 'join',
      joinId: 'abc-123',
      secret: 'the-secret',
    })
  })

  it('parses a session (guest personal) link', () => {
    expect(parseHash('#/session/packedkeydata')).toEqual({ name: 'session', packedKey: 'packedkeydata' })
  })

  it('parses a mysession link', () => {
    expect(parseHash('#/mysession/session-id-here')).toEqual({ name: 'mysession', sessionId: 'session-id-here' })
  })

  it('parses an account link', () => {
    expect(parseHash('#/account/packedaccountkey')).toEqual({ name: 'account', packedKey: 'packedaccountkey' })
  })

  it('falls back to home for an empty or unrecognized hash', () => {
    expect(parseHash('')).toEqual({ name: 'home' })
    expect(parseHash('#/')).toEqual({ name: 'home' })
    expect(parseHash('#/something-unknown')).toEqual({ name: 'home' })
  })

  it('falls back to home when a route is missing its required segment', () => {
    expect(parseHash('#/session')).toEqual({ name: 'home' })
    expect(parseHash('#/join/only-one-part')).toEqual({ name: 'home' })
  })
})

describe('extractHash', () => {
  it('pulls the fragment out of a full URL on any origin', () => {
    expect(extractHash('https://deploy-preview-9--whisper-z.netlify.app/#/session/thekey')).toBe('#/session/thekey')
    expect(extractHash('https://whisper-z.netlify.app/#/account/thekey')).toBe('#/account/thekey')
  })

  it('accepts a bare fragment already starting with #', () => {
    expect(extractHash('#/session/thekey')).toBe('#/session/thekey')
  })

  it('adds a leading #/ to a fragment missing it entirely', () => {
    expect(extractHash('session/thekey')).toBe('#/session/thekey')
  })

  it('adds just a leading # when given a path starting with /', () => {
    expect(extractHash('/session/thekey')).toBe('#/session/thekey')
  })

  it('trims surrounding whitespace from a pasted value', () => {
    expect(extractHash('  #/session/thekey  ')).toBe('#/session/thekey')
  })
})

describe('extractAccountKey', () => {
  it('extracts the key from a full account link on any origin', () => {
    expect(extractAccountKey('https://some-preview.netlify.app/#/account/realkey123')).toBe('realkey123')
  })

  it('extracts the key from a bare account fragment', () => {
    expect(extractAccountKey('#/account/realkey123')).toBe('realkey123')
  })

  it('falls back to treating the whole trimmed input as the key when it is not an account route', () => {
    expect(extractAccountKey('  justabarekey  ')).toBe('justabarekey')
    expect(extractAccountKey('#/session/notAnAccountLink')).toBe('#/session/notAnAccountLink')
  })
})

describe('extractPackedKey', () => {
  it('extracts the key from a session (guest) link', () => {
    expect(extractPackedKey('https://whisper-z.netlify.app/#/session/guestkey')).toBe('guestkey')
  })

  it('extracts the key from an account link', () => {
    expect(extractPackedKey('#/account/accountkey')).toBe('accountkey')
  })

  it('falls back to the whole trimmed input for anything else', () => {
    expect(extractPackedKey('bareprivatekey')).toBe('bareprivatekey')
  })
})

describe('hash builders round-trip with parseHash', () => {
  it('sessionHash', () => {
    expect(parseHash(sessionHash('key1'))).toEqual({ name: 'session', packedKey: 'key1' })
  })

  it('joinHash', () => {
    expect(parseHash(joinHash('id1', 'secret1'))).toEqual({ name: 'join', joinId: 'id1', secret: 'secret1' })
  })

  it('mySessionHash', () => {
    expect(parseHash(mySessionHash('sess1'))).toEqual({ name: 'mysession', sessionId: 'sess1' })
  })

  it('accountHash', () => {
    expect(parseHash(accountHash('key1'))).toEqual({ name: 'account', packedKey: 'key1' })
  })

  it('homeHash', () => {
    expect(parseHash(homeHash)).toEqual({ name: 'home' })
  })
})
