import { fetchSession, type Role } from './session'
import { fetchAccountByPublicKey, type MembershipRow } from './account'
import { importPublicKey, unwrapPrivateKey, jwkToUrlSafe } from '../lib/crypto'
import type { CurrentAccount } from '../lib/auth'
import { logDebug } from '../debug'

export interface ChatListItem {
  membershipId: string
  sessionId: string
  role: Role
  title: string
  otherLabel: string
  packedKey: string | null
}

/**
 * Assembles one chat-list row from a membership: fetches the session to find
 * the other side's public key (for the "who else is here" label) and this
 * account's own public key (needed to re-derive the wrap key), then unwraps
 * the chat's private key so the row is tappable straight into the chat.
 */
export async function buildChatListItem(
  account: CurrentAccount,
  membership: MembershipRow,
): Promise<ChatListItem | null> {
  const session = await fetchSession(membership.session_id)
  if (!session) return null

  const otherPublicKeyJson =
    membership.role === 'starter' ? session.joiner_public_key : session.starter_public_key
  const ownPublicKeyJson =
    membership.role === 'starter' ? session.starter_public_key : session.joiner_public_key

  let otherLabel = 'Waiting for the other person to join'
  if (otherPublicKeyJson) {
    const otherAccount = await fetchAccountByPublicKey(otherPublicKeyJson)
    otherLabel = otherAccount ? otherAccount.username : 'Not on an account yet'
  }

  let packedKey: string | null = null
  if (membership.wrapped_private_key && membership.wrap_iv && ownPublicKeyJson) {
    try {
      const ownPublicKey = await importPublicKey(JSON.parse(ownPublicKeyJson))
      const privateKeyJwk = await unwrapPrivateKey(
        { ciphertext: membership.wrapped_private_key, iv: membership.wrap_iv },
        account.privateKey,
        ownPublicKey,
      )
      packedKey = jwkToUrlSafe(privateKeyJwk)
    } catch (err) {
      logDebug(`Could not unwrap chat key for membership ${membership.id}: ${err}`, 'warn')
    }
  }

  return {
    membershipId: membership.id,
    sessionId: membership.session_id,
    role: membership.role,
    title: membership.title,
    otherLabel,
    packedKey,
  }
}
