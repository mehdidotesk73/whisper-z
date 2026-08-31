// @vitest-environment jsdom
// sessionActions.ts imports lib/route.ts, which touches window.location.hash
// at module load — needs a DOM, unlike the rest of this app's plain-node
// tests. See src/lib/route.test.ts for the same opt-in.
import { describe, it, expect, vi } from 'vitest'
import {
  generateKeyPair,
  generateAdminSigningKeyPair,
  exportPublicKey,
  generateSessionKey,
  exportSessionKey,
  decryptText,
  openSealed,
  deriveCapability,
} from '../lib/crypto'
import { parseParticipantPayload, hasCapability, grantCapability, acceptCapabilityGrant } from './sessionActions'
import type { SessionAccessPayload, CapabilityGrantEntry } from '../lib/sessionTypes'
import type { SessionAccessRow } from './sessions'

const sendMessageMock = vi.fn((..._args: unknown[]) => Promise.resolve(true))
const updateSessionAccessMock = vi.fn((..._args: unknown[]) => Promise.resolve(true))

vi.mock('./sessions', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  updateSessionAccess: (...args: unknown[]) => updateSessionAccessMock(...args),
}))

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

describe('hasCapability', () => {
  it('treats the owner as holding every capability, granted or not', () => {
    expect(hasCapability({ role: 'owner', capabilities: undefined }, 'invite')).toBe(true)
  })

  it('treats a member as holding only what it was explicitly granted', () => {
    expect(hasCapability({ role: 'member', capabilities: { invite: 'some-value' } }, 'invite')).toBe(true)
    expect(hasCapability({ role: 'member', capabilities: { invite: 'some-value' } }, 'rename')).toBe(false)
    expect(hasCapability({ role: 'member', capabilities: undefined }, 'invite')).toBe(false)
  })
})

describe('grantCapability / acceptCapabilityGrant', () => {
  it('round-trips a real grant: the grantee recovers the same value admin derived, self-written into its own row', async () => {
    sendMessageMock.mockClear()
    updateSessionAccessMock.mockClear()

    const admin = await generateKeyPair()
    const adminSigning = await generateAdminSigningKeyPair()
    const grantee = await generateKeyPair()
    const sessionKey = await generateSessionKey()

    const granted = await grantCapability(
      'session-1',
      sessionKey,
      admin.privateKey,
      adminSigning.privateKey,
      await exportPublicKey(grantee.publicKey),
      'invite',
    )
    expect(granted).toBe(true)
    expect(sendMessageMock).toHaveBeenCalledTimes(1)

    // Reconstruct exactly what a fellow participant would read back from session_log.
    const [, ciphertext, iv] = sendMessageMock.mock.calls[0] as [string, string, string]
    const entry = JSON.parse(await decryptText(sessionKey, { ciphertext, iv })) as CapabilityGrantEntry

    const granteePublicKeyId = `${(await exportPublicKey(grantee.publicKey)).x}.${(await exportPublicKey(grantee.publicKey)).y}`
    const accessPayload: SessionAccessPayload = {
      sessionId: 'session-1',
      sessionKey: await exportSessionKey(sessionKey),
      role: 'member',
      adminEcdhPublicKey: await exportPublicKey(admin.publicKey),
      adminSigningPublicKey: await exportPublicKey(adminSigning.publicKey),
    }
    const accessRow = { id: 'row-1' } as SessionAccessRow

    const accepted = await acceptCapabilityGrant(
      entry,
      granteePublicKeyId,
      grantee.privateKey,
      grantee.publicKey,
      accessRow,
      accessPayload,
    )
    expect(accepted).not.toBeNull()
    expect(updateSessionAccessMock).toHaveBeenCalledTimes(1)

    const [rowId, sealedPayload] = updateSessionAccessMock.mock.calls[0] as [string, Parameters<typeof openSealed>[0]]
    expect(rowId).toBe('row-1')
    const updated = await openSealed<SessionAccessPayload>(sealedPayload, grantee.privateKey)
    const expectedValue = await deriveCapability(admin.privateKey, 'invite')
    expect(updated.capabilities).toEqual({ invite: expectedValue })
    expect(accepted?.capabilities).toEqual({ invite: expectedValue })
  })

  it('does not accept a grant addressed to someone else', async () => {
    updateSessionAccessMock.mockClear()

    const admin = await generateKeyPair()
    const adminSigning = await generateAdminSigningKeyPair()
    const grantee = await generateKeyPair()
    const stranger = await generateKeyPair()
    const sessionKey = await generateSessionKey()

    await grantCapability(
      'session-1',
      sessionKey,
      admin.privateKey,
      adminSigning.privateKey,
      await exportPublicKey(grantee.publicKey),
      'invite',
    )
    const [, ciphertext, iv] = sendMessageMock.mock.calls.at(-1) as [string, string, string]
    const entry = JSON.parse(await decryptText(sessionKey, { ciphertext, iv })) as CapabilityGrantEntry

    const strangerPublicKeyId = `${(await exportPublicKey(stranger.publicKey)).x}.${(await exportPublicKey(stranger.publicKey)).y}`
    const accessPayload: SessionAccessPayload = {
      sessionId: 'session-1',
      sessionKey: await exportSessionKey(sessionKey),
      role: 'member',
      adminEcdhPublicKey: await exportPublicKey(admin.publicKey),
      adminSigningPublicKey: await exportPublicKey(adminSigning.publicKey),
    }

    const accepted = await acceptCapabilityGrant(
      entry,
      strangerPublicKeyId,
      stranger.privateKey,
      stranger.publicKey,
      { id: 'row-1' } as SessionAccessRow,
      accessPayload,
    )
    expect(accepted).toBeNull()
    expect(updateSessionAccessMock).not.toHaveBeenCalled()
  })

  it('rejects a grant whose signature does not verify against the claimed admin', async () => {
    updateSessionAccessMock.mockClear()

    const admin = await generateKeyPair()
    const adminSigning = await generateAdminSigningKeyPair()
    const impostorSigning = await generateAdminSigningKeyPair() // a different signing key than the one that actually signed
    const grantee = await generateKeyPair()
    const sessionKey = await generateSessionKey()

    await grantCapability(
      'session-1',
      sessionKey,
      admin.privateKey,
      adminSigning.privateKey,
      await exportPublicKey(grantee.publicKey),
      'invite',
    )
    const [, ciphertext, iv] = sendMessageMock.mock.calls.at(-1) as [string, string, string]
    const entry = JSON.parse(await decryptText(sessionKey, { ciphertext, iv })) as CapabilityGrantEntry

    const granteePublicKeyId = `${(await exportPublicKey(grantee.publicKey)).x}.${(await exportPublicKey(grantee.publicKey)).y}`
    const accessPayload: SessionAccessPayload = {
      sessionId: 'session-1',
      sessionKey: await exportSessionKey(sessionKey),
      role: 'member',
      adminEcdhPublicKey: await exportPublicKey(admin.publicKey),
      // Claims a different admin signing key than the one the entry was actually signed with.
      adminSigningPublicKey: await exportPublicKey(impostorSigning.publicKey),
    }

    const accepted = await acceptCapabilityGrant(
      entry,
      granteePublicKeyId,
      grantee.privateKey,
      grantee.publicKey,
      { id: 'row-1' } as SessionAccessRow,
      accessPayload,
    )
    expect(accepted).toBeNull()
    expect(updateSessionAccessMock).not.toHaveBeenCalled()
  })
})
