import { supabase } from './supabase'
import { logDebug } from '../debug'

// Accounts are the one identity kind whose public key IS meant to be
// searchable — that's how "start a session targeted at this key" and
// "resolve a participant's current username" work. Nothing private (which
// sessions it holds) is stored here; that lives in session_access, looked
// up by lookup tag instead. See docs/system-design.md §3.

export interface AccountRow {
  id: string
  username: string
  public_key: string
  created_at: string
}

export async function createAccount(username: string, publicKeyId: string): Promise<AccountRow | null> {
  const { data, error } = await supabase
    .from('accounts')
    .insert({ username, public_key: publicKeyId })
    .select('*')
    .single()

  if (error) {
    logDebug(`createAccount failed: ${error.message}`, 'error')
    return null
  }
  return data as AccountRow
}

export async function fetchAccountByPublicKey(publicKeyId: string): Promise<AccountRow | null> {
  const { data, error } = await supabase.from('accounts').select('*').eq('public_key', publicKeyId).maybeSingle()

  if (error) {
    logDebug(`fetchAccountByPublicKey failed: ${error.message}`, 'error')
    return null
  }
  return data as AccountRow | null
}

/** Resolves a batch of participant public keys to account usernames, for a chat list or a thread. */
export async function fetchAccountsByPublicKeys(publicKeyIds: string[]): Promise<AccountRow[]> {
  if (!publicKeyIds.length) return []
  const { data, error } = await supabase.from('accounts').select('*').in('public_key', publicKeyIds)

  if (error) {
    logDebug(`fetchAccountsByPublicKeys failed: ${error.message}`, 'error')
    return []
  }
  return data as AccountRow[]
}
