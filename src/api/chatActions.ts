// Starting or joining a chat is the same two steps everywhere it happens
// (ChatHome, JoinChat, and starting a new chat from the account chat list):
// generate a keypair, register it, and — if the caller is logged in — wrap
// and attach it so the chat shows up in their account next time.
import { generateKeyPair, exportPublicKey, exportPrivateKey, jwkToUrlSafe, wrapPrivateKey } from '../lib/crypto'
import { createSession, joinSession } from './session'
import { createMembership } from './account'
import type { CurrentAccount } from '../lib/auth'

export interface ChatCreationResult {
  sessionId: string
  packedKey: string
}

async function attachIfLoggedIn(
  account: CurrentAccount | null,
  sessionId: string,
  role: 'starter' | 'joiner',
  privateKeyJwk: JsonWebKey,
  ownPrivateKey: CryptoKey,
) {
  if (!account) return
  const wrapped = await wrapPrivateKey(privateKeyJwk, ownPrivateKey, account.publicKey)
  await createMembership(account.id, sessionId, role, 'Chat', wrapped)
}

export async function startNewChat(account: CurrentAccount | null): Promise<ChatCreationResult | null> {
  const keyPair = await generateKeyPair()
  const [publicKey, privateKey] = await Promise.all([
    exportPublicKey(keyPair.publicKey),
    exportPrivateKey(keyPair.privateKey),
  ])

  const sessionId = await createSession(publicKey)
  if (!sessionId) return null

  await attachIfLoggedIn(account, sessionId, 'starter', privateKey, keyPair.privateKey)

  return { sessionId, packedKey: jwkToUrlSafe(privateKey) }
}

export async function joinExistingChat(
  sessionId: string,
  account: CurrentAccount | null,
): Promise<ChatCreationResult | 'taken' | null> {
  const keyPair = await generateKeyPair()
  const [publicKey, privateKey] = await Promise.all([
    exportPublicKey(keyPair.publicKey),
    exportPrivateKey(keyPair.privateKey),
  ])

  const ok = await joinSession(sessionId, publicKey)
  if (!ok) return 'taken'

  await attachIfLoggedIn(account, sessionId, 'joiner', privateKey, keyPair.privateKey)

  return { sessionId, packedKey: jwkToUrlSafe(privateKey) }
}
