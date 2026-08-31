// Builds an account's chat list by decrypting its own session_access rows
// client-side — the server-side query only ever sees a lookup tag with some
// number of rows, never which sessions they decrypt to.
import { deriveLookupTag, openSealed, importSessionKey, decryptText } from '../lib/crypto'
import { fetchSessionAccessForOwner, fetchParticipants, fetchLatestMessageTimes, toEnvelope } from './sessions'
import { fetchAccountsByPublicKeys } from './accounts'
import { parseParticipantPayload } from './sessionActions'
import { guestNameForKey } from '../lib/guestName'
import type { SessionAccessPayload } from '../lib/sessionTypes'
import type { CurrentAccount } from '../lib/auth'

export interface SessionListItem {
  sessionId: string
  title: string | null
  role: 'owner' | 'member'
  otherParticipants: string[]
  lastActivityAt: string | null
}

export async function fetchSessionList(account: CurrentAccount): Promise<SessionListItem[]> {
  const ownerTag = await deriveLookupTag(account.privateKey, 'session-access')
  const rows = await fetchSessionAccessForOwner(ownerTag)

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
      const decrypted = await Promise.all(
        participantRows.map((p) => decryptText(sessionKey, { ciphertext: p.ciphertext, iv: p.iv })),
      )
      const publicKeys = decrypted.map((d) => parseParticipantPayload(d).publicKeyId)
      const others = publicKeys.filter((publicKey) => !myIds.has(publicKey))

      const linkedAccounts = await fetchAccountsByPublicKeys(others)
      const usernameByKey = new Map(linkedAccounts.map((a) => [a.public_key, a.username]))
      const otherParticipants = others.map((publicKey) => usernameByKey.get(publicKey) ?? guestNameForKey(publicKey))

      items.push({
        sessionId: payload.sessionId,
        title: payload.title ?? null,
        role: payload.role,
        otherParticipants,
        lastActivityAt: null,
      })
    } catch {
      // A row this key can't open (shouldn't happen for its own tag) — skip rather than fail the list.
    }
  }

  // Sort by most recent message — a session with none yet sinks to the
  // bottom, in whatever order it was otherwise found in.
  const latestTimes = await fetchLatestMessageTimes(items.map((item) => item.sessionId))
  for (const item of items) item.lastActivityAt = latestTimes.get(item.sessionId) ?? null
  items.sort((a, b) => {
    if (!a.lastActivityAt && !b.lastActivityAt) return 0
    if (!a.lastActivityAt) return 1
    if (!b.lastActivityAt) return -1
    return b.lastActivityAt.localeCompare(a.lastActivityAt)
  })

  return items
}
