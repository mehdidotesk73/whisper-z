// Builds an account's chat list by decrypting its own session_access rows
// client-side — the server-side query only ever sees a lookup tag with some
// number of rows, never which sessions they decrypt to.
import { deriveLookupTag, openSealed } from '../lib/crypto'
import { fetchSessionAccessForOwner, fetchParticipants, toEnvelope } from './sessions'
import { fetchAccountsByPublicKeys } from './accounts'
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
      const participants = await fetchParticipants(payload.sessionId)
      const others = participants.filter((p) => p.public_key !== account.publicKeyId)

      const linkedAccounts = await fetchAccountsByPublicKeys(others.map((p) => p.public_key))
      const usernameByKey = new Map(linkedAccounts.map((a) => [a.public_key, a.username]))
      const otherParticipants = others.map((p) => usernameByKey.get(p.public_key) ?? p.display_name ?? 'Someone')

      items.push({ sessionId: payload.sessionId, title: payload.title ?? null, role: payload.role, otherParticipants })
    } catch {
      // A row this key can't open (shouldn't happen for its own tag) — skip rather than fail the list.
    }
  }
  return items
}
