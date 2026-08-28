// Builds an account's chat list by decrypting its own session_access rows
// client-side — the server-side query only ever sees a lookup tag with some
// number of rows, never which sessions they decrypt to.
import { deriveLookupTag, openSealed, importSessionKey, decryptText } from '../lib/crypto'
import { fetchSessionAccessForOwner, fetchParticipants, toEnvelope } from './sessions'
import { fetchAccountsByPublicKeys } from './accounts'
import { guestNameForKey } from '../lib/guestName'
import type { SessionAccessPayload } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

export interface SessionListItem {
  sessionId: string
  title: string | null
  role: 'owner' | 'member'
  otherParticipants: string[]
}

export async function fetchSessionList(account: CurrentAccount): Promise<SessionListItem[]> {
  const ownerPub = await deriveLookupTag(account.privateKey, 'session-access')
  const rows = await fetchSessionAccessForOwner(ownerPub)

  const items: SessionListItem[] = []
  for (const row of rows) {
    try {
      const payload = await openSealed<SessionAccessPayload>(toEnvelope(row), account.privateKey)
      // A migrated session recognizes multiple sender keys as "me": the
      // account's real key (used going forward) plus every guest key merged
      // in via migrateGuestSessionToAccount (used by messages sent under
      // those identities before migration).
      const myIds = new Set([account.publicKeyId, ...(payload.identityPublicKeyIds ?? [])])

      // session_participants rows are encrypted with the session's shared
      // key (see docs/system-design.md §3) — decrypt each to recover the
      // plaintext public key it names.
      const sessionKey = await importSessionKey(payload.sessionKey)
      const participantRows = await fetchParticipants(payload.sessionId)
      const publicKeys = await Promise.all(
        participantRows.map((p) => decryptText(sessionKey, { ciphertext: p.ciphertext, iv: p.iv })),
      )
      const others = publicKeys.filter((publicKey) => !myIds.has(publicKey))

      const linkedAccounts = await fetchAccountsByPublicKeys(others)
      const usernameByKey = new Map(linkedAccounts.map((a) => [a.public_key, a.username]))
      const otherParticipants = others.map((publicKey) => usernameByKey.get(publicKey) ?? guestNameForKey(publicKey))

      items.push({ sessionId: payload.sessionId, title: payload.title ?? null, role: payload.role, otherParticipants })
    } catch {
      // A row this key can't open (shouldn't happen for its own tag) — skip rather than fail the list.
    }
  }
  return items
}
