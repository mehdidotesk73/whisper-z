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
  importPrivateKey,
  importPublicKey,
  publicJwkFromPrivateJwk,
  generateSessionKey,
  exportSessionKey,
  importSessionKey,
  encryptText,
  decryptText,
  sealForRecipient,
  openSealed,
  deriveLookupTag,
  deriveCapability,
  packJwk,
  unpackJwk,
  canonicalPublicKeyId,
  generateAdminSigningKeyPair,
  derivePersonalSigningKeyPair,
  signData,
  verifySignature,
  importEcdsaPublicKey,
} from '../lib/crypto'
import {
  createSession,
  insertSessionAccess,
  updateSessionAccess,
  addParticipant,
  fetchParticipants,
  fetchSessionAccessForOwner,
  sendMessage,
  toEnvelope,
  type SessionAccessRow,
} from './sessions'
import { extractPackedKey } from '../lib/route'
import type { SessionAccessPayload, JoinPayload, ParticipantPayload, CapabilityGrantEntry } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

/** Admin holds every capability by derivation; a member holds only what it's been granted and self-written. */
export function hasCapability(payload: Pick<SessionAccessPayload, 'role' | 'capabilities'>, capability: string): boolean {
  return payload.role === 'owner' || !!payload.capabilities?.[capability]
}

/** Same field order at grant time and verify time — see grantCapability/acceptCapabilityGrant below. */
function capabilityGrantSigningInput(entry: Omit<CapabilityGrantEntry, 'kind' | 'signature'>): string {
  return JSON.stringify({
    kind: 'capability-grant',
    granteePublicKeyId: entry.granteePublicKeyId,
    capability: entry.capability,
    timestamp: entry.timestamp,
    sealedSecret: entry.sealedSecret,
  })
}

/**
 * Admin grants a capability to another participant — an ordinary session_log
 * entry (see CapabilityGrantEntry's doc comment for why it's folded in
 * rather than a dedicated table). Only admin can call this meaningfully:
 * deriving the capability's actual value requires adminEcdhPrivateKey, which
 * only the session creator's own row ever holds.
 */
export async function grantCapability(
  sessionId: string,
  sessionKey: CryptoKey,
  adminEcdhPrivateKey: CryptoKey,
  adminSigningPrivateKey: CryptoKey,
  granteePublicKeyJwk: JsonWebKey,
  capability: string,
): Promise<boolean> {
  const granteePublicKey = await importPublicKey(granteePublicKeyJwk)
  const capabilityValue = await deriveCapability(adminEcdhPrivateKey, capability)
  const sealedSecret = await sealForRecipient(capabilityValue, granteePublicKey)
  const unsigned = {
    granteePublicKeyId: canonicalPublicKeyId(granteePublicKeyJwk),
    capability,
    timestamp: new Date().toISOString(),
    sealedSecret,
  }
  const signature = await signData(adminSigningPrivateKey, capabilityGrantSigningInput(unsigned))
  const entry: CapabilityGrantEntry = { kind: 'capability-grant', ...unsigned, signature }
  const { ciphertext, iv } = await encryptText(sessionKey, JSON.stringify(entry))
  return sendMessage(sessionId, ciphertext, iv)
}

/**
 * The grantee's side: verify the grant really came from this session's
 * admin, then self-write the recovered capability value into `capabilities`
 * on the caller's own session_access row (accessRow/accessPayload — the row
 * this identity already opened for itself, guest or account alike). Returns
 * false (a no-op, not an error) for a grant addressed to someone else, or
 * one whose signature doesn't check out. Returns the updated payload (not
 * just a boolean) so the caller can sync its own in-memory copy — e.g. to
 * flip a UI gate on immediately — without re-deriving anything itself.
 */
export async function acceptCapabilityGrant(
  entry: CapabilityGrantEntry,
  ownPublicKeyId: string,
  ownPrivateKey: CryptoKey,
  ownPublicKey: CryptoKey,
  accessRow: SessionAccessRow,
  accessPayload: SessionAccessPayload,
): Promise<SessionAccessPayload | null> {
  if (entry.granteePublicKeyId !== ownPublicKeyId) return null
  if (!accessPayload.adminSigningPublicKey) return null

  const adminSigningKey = await importEcdsaPublicKey(accessPayload.adminSigningPublicKey)
  const signingInput = capabilityGrantSigningInput(entry)
  const valid = await verifySignature(adminSigningKey, entry.signature, signingInput)
  if (!valid) return null

  const capabilityValue = await openSealed<string>(entry.sealedSecret, ownPrivateKey)
  const payload: SessionAccessPayload = {
    ...accessPayload,
    capabilities: { ...(accessPayload.capabilities ?? {}), [entry.capability]: capabilityValue },
  }
  const sealed = await sealForRecipient(payload, ownPublicKey)
  const ok = await updateSessionAccess(accessRow.id, sealed)
  return ok ? payload : null
}

/**
 * A session_participants row decrypts to a bare public-key-id string if it
 * predates Stage E, or a ParticipantPayload JSON object if it doesn't — see
 * lib/sessionTypes.ts's ParticipantPayload doc comment. Every reader of a
 * participant row goes through this rather than assuming either shape.
 */
export function parseParticipantPayload(decrypted: string): Partial<ParticipantPayload> & { publicKeyId: string } {
  try {
    const parsed = JSON.parse(decrypted)
    if (parsed && typeof parsed === 'object' && typeof parsed.publicKeyId === 'string') return parsed
  } catch {
    // Not JSON — a legacy row whose whole decrypted value IS the bare public key.
  }
  return { publicKeyId: decrypted }
}

/** Encrypts and inserts a session_participants row for `identity`, publishing its personal signing public key alongside its public-key id (see ParticipantPayload). Used by every join path below. */
async function addParticipantForIdentity(
  sessionId: string,
  sessionKey: CryptoKey,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<void> {
  const publicKeyId = canonicalPublicKeyId(await exportPublicKey(publicKey))
  const signingKey = await derivePersonalSigningKeyPair(privateKey)
  const signingPublicKey = publicJwkFromPrivateJwk(await exportPrivateKey(signingKey))
  const payload: ParticipantPayload = { publicKeyId, signingPublicKey }
  const entry = await encryptText(sessionKey, JSON.stringify(payload))
  await addParticipant(sessionId, entry.ciphertext, entry.iv)
}

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
  const ownerTag = await deriveLookupTag(account.privateKey, 'session-access')
  const rows = await fetchSessionAccessForOwner(ownerTag)
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
      const decrypted = await decryptText(sessionKey, { ciphertext: row.ciphertext, iv: row.iv })
      if (parseParticipantPayload(decrypted).publicKeyId === publicKeyId) return true
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

  // Two keypairs generated fresh here, tied to this session and nothing
  // else — neither derived from the creator's own identity. See
  // docs/system-design.md §3's "Stage E" entry for why that separation
  // matters (blast radius: compromising a session's admin material must
  // never threaten the creator's real account).
  const adminEcdhKeyPair = await generateKeyPair()
  const adminSigningKeyPair = await generateAdminSigningKeyPair()

  const payload: SessionAccessPayload = {
    sessionId,
    sessionKey: sessionKeyJwk,
    role: 'owner',
    title,
    adminEcdhPublicKey: await exportPublicKey(adminEcdhKeyPair.publicKey),
    adminSigningPublicKey: await exportPublicKey(adminSigningKeyPair.publicKey),
    adminEcdhPrivateKey: await exportPrivateKey(adminEcdhKeyPair.privateKey),
    adminSigningPrivateKey: await exportPrivateKey(adminSigningKeyPair.privateKey),
  }
  const sealed = await sealForRecipient(payload, identity.publicKey)
  const ownerTag = await deriveLookupTag(identity.privateKey, 'session-access')

  const ok = await insertSessionAccess(ownerTag, sealed)
  if (!ok) return null

  await addParticipantForIdentity(sessionId, sessionKey, identity.privateKey, identity.publicKey)

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
    // Forwarded, not generated — a member never holds admin key material,
    // only the public halves needed to verify admin-signed entries.
    adminEcdhPublicKey: joinPayload.adminEcdhPublicKey,
    adminSigningPublicKey: joinPayload.adminSigningPublicKey,
  }
  const sealed = await sealForRecipient(payload, identity.publicKey)
  const ownerTag = await deriveLookupTag(identity.privateKey, 'session-access')

  const ok = await insertSessionAccess(ownerTag, sealed)
  if (!ok) return null

  const sessionKey = await importSessionKey(joinPayload.sessionKey)
  await addParticipantForIdentity(joinPayload.sessionId, sessionKey, identity.privateKey, identity.publicKey)

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
 *
 * Takes the guest's whole decrypted payload, not just sessionId/sessionKey/
 * role, so anything else it carries — Stage E's admin key fields, a future
 * title — rides along into the account's row too rather than being silently
 * dropped by this call's own parameter list (a real bug an earlier,
 * narrower signature had: a guest identity that happened to be a session's
 * admin, or held a title, would have lost both on migration).
 */
export async function migrateGuestSessionToAccount(
  guestPayload: SessionAccessPayload,
  guestPublicKeyId: string,
  account: CurrentAccount,
): Promise<boolean> {
  const { sessionId, sessionKey: sessionKeyJwk } = guestPayload
  const existing = await findAccessRow(account, sessionId)

  if (existing) {
    const identityPublicKeyIds = new Set(existing.payload.identityPublicKeyIds ?? [])
    if (!identityPublicKeyIds.has(guestPublicKeyId)) {
      identityPublicKeyIds.add(guestPublicKeyId)
      const payload: SessionAccessPayload = {
        ...existing.payload,
        identityPublicKeyIds: [...identityPublicKeyIds],
        // A session has exactly one admin; this only fills a gap if the
        // account's own existing row somehow lacks these while the guest
        // identity being merged in has them (defensive, not the normal case).
        adminEcdhPublicKey: existing.payload.adminEcdhPublicKey ?? guestPayload.adminEcdhPublicKey,
        adminSigningPublicKey: existing.payload.adminSigningPublicKey ?? guestPayload.adminSigningPublicKey,
        adminEcdhPrivateKey: existing.payload.adminEcdhPrivateKey ?? guestPayload.adminEcdhPrivateKey,
        adminSigningPrivateKey: existing.payload.adminSigningPrivateKey ?? guestPayload.adminSigningPrivateKey,
      }
      const sealed = await sealForRecipient(payload, account.publicKey)
      const ok = await updateSessionAccess(existing.row.id, sealed)
      if (!ok) return false
    }
  } else {
    const payload: SessionAccessPayload = { ...guestPayload, identityPublicKeyIds: [guestPublicKeyId] }
    const sealed = await sealForRecipient(payload, account.publicKey)
    const ownerTag = await deriveLookupTag(account.privateKey, 'session-access')
    const ok = await insertSessionAccess(ownerTag, sealed)
    if (!ok) return false
  }

  const sessionKey = await importSessionKey(sessionKeyJwk)
  if (!(await hasParticipant(sessionId, sessionKey, account.publicKeyId))) {
    await addParticipantForIdentity(sessionId, sessionKey, account.privateKey, account.publicKey)
  }
  return true
}

/**
 * The account-level entry point for "adopt an alias" — paste any guest
 * identity's private key (a personal link, or the bare key), and this
 * figures out which session it belongs to itself, rather than requiring
 * the account to already be viewing that session. A guest identity holds
 * exactly one session_access row by construction (a fresh keypair per
 * visit), so its own lookup tag has exactly one row to open. From the
 * user's side this is "adopt a guest account" — a single, session-agnostic
 * action — even though underneath it's still exactly migrateGuestSessionToAccount.
 */
export async function adoptGuestIdentity(pasted: string, account: CurrentAccount): Promise<boolean> {
  const privateKeyJwk = unpackJwk(extractPackedKey(pasted))
  const guestPrivateKey = await importPrivateKey(privateKeyJwk)
  const guestPublicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(privateKeyJwk))

  const ownerTag = await deriveLookupTag(guestPrivateKey, 'session-access')
  const rows = await fetchSessionAccessForOwner(ownerTag)
  if (!rows.length) return false

  const payload = await openSealed<SessionAccessPayload>(toEnvelope(rows[0]), guestPrivateKey)
  return migrateGuestSessionToAccount(payload, guestPublicKeyId, account)
}
