// Shared, identity-agnostic "start" and "join" logic. A logged-in account
// and a logged-out guest go through the exact same steps — sealForRecipient,
// deriveLookupTag, addParticipant — the only difference is which keypair
// does the sealing: an account's stable keypair (reused across every
// session it holds) vs. a fresh one-off keypair (kept alive only by saving
// its personal link). There is one session system; this is the "different
// ways to access it" seam.
import {
  generateKeyPair,
  exportPublicKey,
  exportPrivateKey,
  generateSessionKey,
  exportSessionKey,
  sealForRecipient,
  deriveLookupTag,
  packJwk,
  canonicalPublicKeyId,
} from '../lib/crypto'
import { createSession, insertSessionAccess, addParticipant } from './sessions'
import { randomGuestName } from '../lib/guestName'
import type { SessionAccessPayload, JoinPayload } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

interface Identity {
  privateKey: CryptoKey
  publicKey: CryptoKey
  displayName: string | null // null for an account holder — resolved live from `accounts` instead
}

async function resolveIdentity(account: CurrentAccount | null): Promise<Identity> {
  if (account) {
    return { privateKey: account.privateKey, publicKey: account.publicKey, displayName: null }
  }
  const identity = await generateKeyPair()
  return { privateKey: identity.privateKey, publicKey: identity.publicKey, displayName: randomGuestName() }
}

export interface StartedSession {
  sessionId: string
  /** A personal-link fragment for a guest identity; null for an account (use mySessionHash instead). */
  packedKey: string | null
}

export async function startNewSession(account: CurrentAccount | null, title?: string): Promise<StartedSession | null> {
  const sessionId = await createSession()
  if (!sessionId) return null

  const identity = await resolveIdentity(account)
  const sessionKey = await generateSessionKey()
  const sessionKeyJwk = await exportSessionKey(sessionKey)

  const payload: SessionAccessPayload = { sessionId, sessionKey: sessionKeyJwk, role: 'owner', title }
  const sealed = await sealForRecipient(payload, identity.publicKey)
  const ownerPub = await deriveLookupTag(identity.privateKey, 'session-access')

  const ok = await insertSessionAccess(ownerPub, sealed)
  if (!ok) return null

  const publicKeyId = canonicalPublicKeyId(await exportPublicKey(identity.publicKey))
  await addParticipant(sessionId, publicKeyId, identity.displayName)

  const packedKey = account ? null : packJwk(await exportPrivateKey(identity.privateKey))
  return { sessionId, packedKey }
}

export async function joinExistingSession(
  joinPayload: JoinPayload,
  account: CurrentAccount | null,
): Promise<StartedSession | null> {
  const identity = await resolveIdentity(account)

  const payload: SessionAccessPayload = {
    sessionId: joinPayload.sessionId,
    sessionKey: joinPayload.sessionKey,
    role: 'member',
  }
  const sealed = await sealForRecipient(payload, identity.publicKey)
  const ownerPub = await deriveLookupTag(identity.privateKey, 'session-access')

  const ok = await insertSessionAccess(ownerPub, sealed)
  if (!ok) return null

  const publicKeyId = canonicalPublicKeyId(await exportPublicKey(identity.publicKey))
  await addParticipant(joinPayload.sessionId, publicKeyId, identity.displayName)

  const packedKey = account ? null : packJwk(await exportPrivateKey(identity.privateKey))
  return { sessionId: joinPayload.sessionId, packedKey }
}
