// Reactive login state, backed by a single packed private key in
// localStorage. An account is architecturally just another identity: it
// uses the same keypair + deriveLookupTag('session-access') mechanism a
// guest does, except the tag is stable across every session because the
// keypair never changes — that's what lets one query rebuild a whole chat
// list. See docs/system-design.md §3.
import { ref } from 'vue'
import { importPrivateKey, importPublicKey, publicJwkFromPrivateJwk, canonicalPublicKeyId, unpackJwk } from './crypto'
import { fetchAccountByPublicKey, type AccountRow } from '../api/accounts'
import { logDebug } from '../debug'

const STORAGE_KEY = 'whisperz-account-key'

export interface CurrentAccount {
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicKeyId: string
  account: AccountRow
}

export const currentAccount = ref<CurrentAccount | null>(null)

/** Adopts an already-known keypair + account row (e.g. right after creating one) and persists it. */
export function setCurrentAccount(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  publicKeyId: string,
  account: AccountRow,
  packedKey: string,
) {
  currentAccount.value = { privateKey, publicKey, publicKeyId, account }
  localStorage.setItem(STORAGE_KEY, packedKey)
}

export async function loginWithPackedKey(packedKey: string): Promise<boolean> {
  try {
    const jwk = unpackJwk(packedKey)
    const privateKey = await importPrivateKey(jwk)
    const publicJwk = publicJwkFromPrivateJwk(jwk)
    const publicKey = await importPublicKey(publicJwk)
    const publicKeyId = canonicalPublicKeyId(publicJwk)

    const account = await fetchAccountByPublicKey(publicKeyId)
    if (!account) return false

    setCurrentAccount(privateKey, publicKey, publicKeyId, account, packedKey)
    return true
  } catch (err) {
    logDebug(`loginWithPackedKey failed: ${err}`, 'error')
    return false
  }
}

export function logout() {
  currentAccount.value = null
  localStorage.removeItem(STORAGE_KEY)
}

/** Called once on app boot — silently does nothing if no account was ever saved on this device. */
export async function tryAutoLogin(): Promise<void> {
  const packedKey = localStorage.getItem(STORAGE_KEY)
  if (!packedKey) return
  await loginWithPackedKey(packedKey)
}
