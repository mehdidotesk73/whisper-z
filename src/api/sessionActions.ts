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
  importSessionKey,
  encryptText,
  decryptText,
  sealForRecipient,
  openSealed,
  deriveLookupTag,
  packJwk,
  canonicalPublicKeyId,
} from '../lib/crypto'
import {
  createSession,
  insertSessionAccess,
  updateSessionAccess,
  addParticipant,
  fetchParticipants,
  fetchSessionAccessForOwner,
  toEnvelope,
  type SessionAccessRow,
} from './sessions'
import type { SessionAccessPayload, JoinPayload } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

/**
 * Finds the one session_access row (if any) an account already holds for a
 * given session — an account's tag can have many rows, one per session, but
 * never more than one for the same session (migrateGuestSessionToAccount
 * merges into an existing row rather than inserting a second one).
 */
async function findAccessRow(
  account: CurrentAccount,
  sessionId: string,
): Promise<{ row: SessionAccessRow; payload: SessionAccessPayload } | null> {
  const ownerPub = await deriveLookupTag(account.privateKey, 'session-access')
  const rows = await fetchSessionAccessForOwner(ownerPub)
  for (const row of rows) {
    try {
      const payload = await openSealed<SessionAccessPayload>(toEnvelope(row), account.privateKey)
      if (payload.sessionId === sessionId) return { row, payload }
    } catch {
      // Not openable by this identity — not this session's row, ignore.
    }
  }
  return null
}

/**
 * An account's tag is stable, so opening an invite link to a session it
 * already holds (e.g. the owner re-opening their own invite, or a link
 * shared twice) would otherwise just add a duplicate session_access +
 * session_participants row on every visit. A guest never needs this check:
 * each visit generates a brand new keypair, so it can never already hold
 * access to anything.
 */
export async function alreadyHasAccess(account: CurrentAccount, sessionId: string): Promise<boolean> {
  return (await findAccessRow(account, sessionId)) !== null
}

/**
 * Whether this *specific* guest identity has already been merged into the
 * account's access row for this session — narrower than alreadyHasAccess,
 * which is true the moment the account has ANY row for the session (e.g.
 * from joining it directly under its own key) even if this particular guest
 * visit was never linked in. Used to decide whether "+ Add to account"
 * still has something to do.
 */
export async function isIdentityMerged(
  account: CurrentAccount,
  sessionId: string,
  guestPublicKeyId: string,
): Promise<boolean> {
  const existing = await findAccessRow(account, sessionId)
  return existing?.payload.identityPublicKeyIds?.includes(guestPublicKeyId) ?? false
}

async function hasParticipant(sessionId: string, sessionKey: CryptoKey, publicKeyId: string): Promise<boolean> {
  const rows = await fetchParticipants(sessionId)
  for (const row of rows) {
    try {
      const key = await decryptText(sessionKey, { ciphertext: row.ciphertext, iv: row.iv })
      if (key === publicKeyId) return true
    } catch {
      // Not decryptable with this session's key — shouldn't happen, ignore.
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
  const participantEntry = await encryptText(sessionKey, publicKeyId)
  await addParticipant(sessionId, participantEntry.ciphertext, participantEntry.iv)

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

  const sessionKey = await importSessionKey(joinPayload.sessionKey)
  const publicKeyId = canonicalPublicKeyId(await exportPublicKey(identity.publicKey))
  const participantEntry = await encryptText(sessionKey, publicKeyId)
  await addParticipant(joinPayload.sessionId, participantEntry.ciphertext, participantEntry.iv)

  const packedKey = account ? null : packJwk(await exportPrivateKey(identity.privateKey))
  return { sessionId: joinPayload.sessionId, packedKey }
}

/**
 * Merges a guest identity's session into an account — without re-keying or
 * touching the guest's original session_participants row. If the account
 * has no access row for this session yet (the common case: it only ever
 * held this session as a guest), one is created, sealed to the account's
 * real public key, with `identityPublicKeyIds` pinned to the guest's
 * original public key. If the account *already* has a row for this session
 * — e.g. it separately joined the session directly under its own key before
 * ever linking this particular guest visit in — that row is updated in
 * place, adding the guest's key to its `identityPublicKeyIds` array, rather
 * than inserting a second row for the same session (which would leave
 * SessionView's "find the row for this sessionId" search to arbitrarily
 * pick one of two, silently dropping whichever pin it didn't land on). Only
 * this private hint changes; nobody else's data is touched, and the
 * account still sends as itself going forward — see the comment on
 * `identityPublicKeyIds` in lib/sessionTypes.ts. A session_participants row
 * for the account's real key is added only if one doesn't already exist
 * (skipped when the account already joined this session directly).
 * Idempotent per guest identity — migrating the same guest key twice is a
 * no-op past the first merge.
 */
export async function migrateGuestSessionToAccount(
  sessionId: string,
  sessionKeyJwk: JsonWebKey,
  role: 'owner' | 'member',
  guestPublicKeyId: string,
  account: CurrentAccount,
): Promise<boolean> {
  const existing = await findAccessRow(account, sessionId)

  if (existing) {
    const identityPublicKeyIds = new Set(existing.payload.identityPublicKeyIds ?? [])
    if (!identityPublicKeyIds.has(guestPublicKeyId)) {
      identityPublicKeyIds.add(guestPublicKeyId)
      const payload: SessionAccessPayload = { ...existing.payload, identityPublicKeyIds: [...identityPublicKeyIds] }
      const sealed = await sealForRecipient(payload, account.publicKey)
      const ok = await updateSessionAccess(existing.row.id, sealed)
      if (!ok) return false
    }
  } else {
    const payload: SessionAccessPayload = {
      sessionId,
      sessionKey: sessionKeyJwk,
      role,
      identityPublicKeyIds: [guestPublicKeyId],
    }
    const sealed = await sealForRecipient(payload, account.publicKey)
    const ownerPub = await deriveLookupTag(account.privateKey, 'session-access')
    const ok = await insertSessionAccess(ownerPub, sealed)
    if (!ok) return false
  }

  const sessionKey = await importSessionKey(sessionKeyJwk)
  if (!(await hasParticipant(sessionId, sessionKey, account.publicKeyId))) {
    const participantEntry = await encryptText(sessionKey, account.publicKeyId)
    await addParticipant(sessionId, participantEntry.ciphertext, participantEntry.iv)
  }
  return true
}
