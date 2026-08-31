// @vitest-environment jsdom
// sessionActions.ts imports lib/route.ts, which touches window.location.hash
// at module load — needs a DOM, unlike the rest of this app's plain-node
// tests. See src/lib/route.test.ts for the same opt-in.
import { describe, it, expect } from 'vitest'
import { parseParticipantPayload } from './sessionActions'

describe('parseParticipantPayload', () => {
  it('parses a Stage E participant payload', () => {
    const signingPublicKey: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' }
    const decrypted = JSON.stringify({ publicKeyId: 'some-key-id', signingPublicKey })

    expect(parseParticipantPayload(decrypted)).toEqual({ publicKeyId: 'some-key-id', signingPublicKey })
  })

  it('treats a legacy (pre-Stage-E) bare public-key-id string as its own publicKeyId, with no signing key', () => {
    const decrypted = 'some-legacy-key-id.another-part'

    expect(parseParticipantPayload(decrypted)).toEqual({ publicKeyId: decrypted })
  })

  it('falls back to treating unrecognized JSON as a bare id rather than throwing', () => {
    const decrypted = JSON.stringify({ unrelated: 'shape' })

    expect(parseParticipantPayload(decrypted)).toEqual({ publicKeyId: decrypted })
  })
})
