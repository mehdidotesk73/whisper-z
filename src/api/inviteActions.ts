// Session invites: add an existing account to a session by their public key,
// exchanged out of band (physically — a QR code, read aloud, whatever channel
// the two people already trust) rather than looked up by username through the
// app. See lib/crypto.ts's "Pairwise discoverable secrets" section for why:
// a server-side username lookup would itself be an observable event tying an
// inviter to an invitee, defeating the same hidden-membership-graph property
// session_access already protects. An invite's payload is exactly a
// JoinPayload — accepting one is exactly joinExistingSession, nothing new.
import {
  importPublicKey,
  publicKeyFromCanonicalId,
  derivePairwiseSecret,
  derivePairwiseTag,
  derivePairwiseKey,
  encryptText,
  decryptText,
} from '../lib/crypto'
import { createInvite, fetchInvitesByTags, deleteInvite, type InviteRow } from './invites'
import { fetchAllAccounts } from './accounts'
import { joinExistingSession, type StartedSession } from './sessionActions'
import type { JoinPayload } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

const TAG_PURPOSE = 'session-invite-tag'
const KEY_PURPOSE = 'session-invite-key'

export interface CreatedInvite {
  id: string
}

/** Sends an invite sealed to a public key the inviter obtained out of band — no lookup, no link. */
export async function createSessionInvite(
  joinPayload: JoinPayload,
  inviterPrivateKey: CryptoKey,
  targetPublicKeyJwk: JsonWebKey,
): Promise<CreatedInvite | null> {
  const targetPublicKey = await importPublicKey(targetPublicKeyJwk)
  const secret = await derivePairwiseSecret(inviterPrivateKey, targetPublicKey)
  const tag = await derivePairwiseTag(secret, TAG_PURPOSE)
  const key = await derivePairwiseKey(secret, KEY_PURPOSE)
  const { ciphertext, iv } = await encryptText(key, JSON.stringify(joinPayload))

  const id = await createInvite(tag, ciphertext, iv)
  return id ? { id } : null
}

export interface PendingInvite {
  id: string
  payload: JoinPayload
}

/**
 * Checks every other known account (accounts.public_key is already the one
 * public directory in this schema) for a matching invite tag, then decrypts
 * whatever matches with the corresponding pairwise key. One indexed query,
 * never a scan of every invite row.
 */
export async function checkForInvites(account: CurrentAccount): Promise<PendingInvite[]> {
  const accounts = await fetchAllAccounts()
  const tagToKey = new Map<string, CryptoKey>()

  for (const candidate of accounts) {
    if (candidate.public_key === account.publicKeyId) continue
    const candidatePublicKey = await importPublicKey(publicKeyFromCanonicalId(candidate.public_key))
    const secret = await derivePairwiseSecret(account.privateKey, candidatePublicKey)
    const tag = await derivePairwiseTag(secret, TAG_PURPOSE)
    const key = await derivePairwiseKey(secret, KEY_PURPOSE)
    tagToKey.set(tag, key)
  }

  const rows = await fetchInvitesByTags([...tagToKey.keys()])
  const invites: PendingInvite[] = []
  for (const row of rows) {
    const key = tagToKey.get(row.tag)
    if (!key) continue
    try {
      const payload = JSON.parse(await decryptText(key, { ciphertext: row.ciphertext, iv: row.iv })) as JoinPayload
      invites.push({ id: row.id, payload })
    } catch {
      // A tag collision without a real matching key is astronomically unlikely — skip rather than fail the list.
    }
  }
  return invites
}

/** Accepting an invite is exactly a normal join — the invite just delivered the JoinPayload privately. */
export async function acceptInvite(invite: PendingInvite, account: CurrentAccount): Promise<StartedSession | null> {
  const result = await joinExistingSession(invite.payload, account, 'invite')
  if (result) await deleteInvite(invite.id)
  return result
}

/** Reject (invitee) and cancel (inviter) are both just "delete the row" — see invites.ts. */
export async function rejectInvite(inviteId: string): Promise<boolean> {
  return deleteInvite(inviteId)
}
