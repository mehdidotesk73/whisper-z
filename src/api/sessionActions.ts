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
  openSealed,
  deriveLookupTag,
  packJwk,
  canonicalPublicKeyId,
} from '../lib/crypto'
import { createSession, insertSessionAccess, addParticipant, fetchSessionAccessForOwner, toEnvelope } from './sessions'
import type { SessionAccessPayload, JoinPayload } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

/**
 * An account's tag is stable, so opening an invite link to a session it
 * already holds (e.g. the owner re-opening their own invite, or a link
 * shared twice) would otherwise just add a duplicate session_access +
 * session_participants row on every visit. A guest never needs this check:
 * each visit generates a brand new keypair, so it can never already hold
 * access to anything.
 */
export async function alreadyHasAccess(account: CurrentAccount, sessionId: string): Promise<boolean> {
  const ownerPub = await deriveLookupTag(account.privateKey, 'session-access')
  const rows = await fetchSessionAccessForOwner(ownerPub)
  for (const row of rows) {
    try {
      const payload = await openSealed<SessionAccessPayload>(toEnvelope(row), account.privateKey)
      if (payload.sessionId === sessionId) return true
    } catch {
      // Not openable by this identity — not this session's row, ignore.
    }
  }
  return false
}

interface Identity {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

async function resolveIdentity(account: CurrentAccount | null): Promise<Identity> {
  if (account) {
    return { privateKey: account.privateKey, publicKey: account.publicKey }
  }
  return generateKeyPair()
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
  await addParticipant(sessionId, publicKeyId)

  const packedKey = account ? null : packJwk(await exportPrivateKey(identity.privateKey))
  return { sessionId, packedKey }
}

export async function joinExistingSession(
  joinPayload: JoinPayload,
  account: CurrentAccount | null,
): Promise<StartedSession | null> {
  if (account && (await alreadyHasAccess(account, joinPayload.sessionId))) {
    return { sessionId: joinPayload.sessionId, packedKey: null }
  }

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
  await addParticipant(joinPayload.sessionId, publicKeyId)

  const packedKey = account ? null : packJwk(await exportPrivateKey(identity.privateKey))
  return { sessionId: joinPayload.sessionId, packedKey }
}

/**
 * Adds an account's own access to a session it currently only holds as a
 * guest (via a personal link) — without re-keying or touching the guest's
 * original session_participants row. The account's copy of session_access
 * still carries `identityPublicKeyId` pinned to the guest's original public
 * key, but only so the account's *own* client can recognize old messages
 * (sent under that key) as "mine" for bubble styling — see the comment on
 * that field in lib/sessionTypes.ts. It plays no part in what anyone else
 * sees. From here on the account sends as itself: a *new* session_participants
 * row is added for the account's real public key, so future messages (sent
 * under that real key, resolving live to the account's current username for
 * everyone, not just the account itself) show up as a distinct, genuine
 * participant — while the original guest identity's own messages stay
 * exactly as they were. Idempotent — migrating twice just confirms access
 * already exists, without adding a second participant row.
 */
export async function migrateGuestSessionToAccount(
  sessionId: string,
  sessionKeyJwk: JsonWebKey,
  role: 'owner' | 'member',
  guestPublicKeyId: string,
  account: CurrentAccount,
): Promise<boolean> {
  if (await alreadyHasAccess(account, sessionId)) return true

  const payload: SessionAccessPayload = {
    sessionId,
    sessionKey: sessionKeyJwk,
    role,
    identityPublicKeyId: guestPublicKeyId,
  }
  const sealed = await sealForRecipient(payload, account.publicKey)
  const ownerPub = await deriveLookupTag(account.privateKey, 'session-access')
  const ok = await insertSessionAccess(ownerPub, sealed)
  if (!ok) return false

  await addParticipant(sessionId, account.publicKeyId)
  return true
}
