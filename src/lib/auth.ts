// Who's logged in, on this device. The account private key is held only in
// memory (as a CryptoKey) plus, so reopening the app doesn't require
// re-pasting the account link, a packed copy in localStorage — private to
// this browser, never sent anywhere, same custody model as a chat's
// personal link, just persisted locally instead of living only in the URL.
import { ref } from 'vue'
import { importPrivateKey, importPublicKey, urlSafeToJwk } from './crypto'
import { fetchAccount } from '../api/account'
import { logDebug } from '../debug'

export interface CurrentAccount {
  id: string
  username: string
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export const currentAccount = ref<CurrentAccount | null>(null)

const STORAGE_KEY = 'whisper-z-account'

function saveCredential(id: string, packedKey: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, packedKey }))
  } catch (err) {
    // Private browsing / blocked storage: login for this tab still works,
    // it just won't survive a reload. Worth a log line, not a hard failure.
    logDebug(`Could not persist account login: ${err}`, 'warn')
  }
}

export function loadStoredCredential(): { id: string; packedKey: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearStoredCredential() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // nothing to clean up if storage isn't available
  }
}

/** Loads an account from its id + packed private key, and remembers it on this device. */
export async function loginWithCredential(id: string, packedKey: string): Promise<boolean> {
  const account = await fetchAccount(id)
  if (!account) return false

  const privateKey = await importPrivateKey(urlSafeToJwk(packedKey))
  const publicKey = await importPublicKey(JSON.parse(account.public_key))

  currentAccount.value = { id: account.id, username: account.username, publicKey, privateKey }
  saveCredential(id, packedKey)
  return true
}

export function logout() {
  clearStoredCredential()
  currentAccount.value = null
}
