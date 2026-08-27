import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { logDebug } from '../debug'
import type { Role } from './session'

const UNIQUE_VIOLATION = '23505' // Postgres error code, reused below for two different constraints

export interface AccountRow {
  id: string
  username: string
  public_key: string
  created_at: string
}

export interface MembershipRow {
  id: string
  account_id: string
  session_id: string
  role: Role
  title: string
  wrapped_private_key: string | null
  wrap_iv: string | null
  status: 'active' | 'pending'
  created_at: string
}

export type CreateAccountResult =
  | { ok: true; account: AccountRow }
  | { ok: false; reason: 'taken' | 'error' }

export async function createAccount(username: string, publicKey: JsonWebKey): Promise<CreateAccountResult> {
  const { data, error } = await supabase
    .from('accounts')
    .insert({ username, public_key: JSON.stringify(publicKey) })
    .select('*')
    .single()

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, reason: 'taken' }
    logDebug(`createAccount failed: ${error.message}`, 'error')
    return { ok: false, reason: 'error' }
  }
  return { ok: true, account: data as AccountRow }
}

export async function fetchAccount(accountId: string): Promise<AccountRow | null> {
  const { data, error } = await supabase.from('accounts').select('*').eq('id', accountId).single()

  if (error) {
    logDebug(`fetchAccount failed: ${error.message}`, 'error')
    return null
  }
  return data as AccountRow
}

/** Reverse lookup for chat-list display: "who is the other side of this chat?" */
export async function fetchAccountByPublicKey(publicKeyJson: string): Promise<AccountRow | null> {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('public_key', publicKeyJson)
    .maybeSingle()

  if (error) {
    logDebug(`fetchAccountByPublicKey failed: ${error.message}`, 'error')
    return null
  }
  return data as AccountRow | null
}

export async function fetchMemberships(accountId: string): Promise<MembershipRow[]> {
  const { data, error } = await supabase
    .from('chat_memberships')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })

  if (error) {
    logDebug(`fetchMemberships failed: ${error.message}`, 'error')
    return []
  }
  return data as MembershipRow[]
}

/**
 * Attaches a chat to an account. Idempotent — attaching the same chat twice
 * (e.g. the paste-to-attach box run again) is treated as success rather than
 * an error, since the `unique (account_id, session_id)` constraint is what's
 * actually enforcing "don't duplicate."
 */
export async function createMembership(
  accountId: string,
  sessionId: string,
  role: Role,
  title: string,
  wrapped: { ciphertext: string; iv: string } | null,
): Promise<boolean> {
  const { error } = await supabase.from('chat_memberships').insert({
    account_id: accountId,
    session_id: sessionId,
    role,
    title,
    wrapped_private_key: wrapped?.ciphertext ?? null,
    wrap_iv: wrapped?.iv ?? null,
  })

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return true // already attached
    logDebug(`createMembership failed: ${error.message}`, 'error')
    return false
  }
  return true
}

/** Fires when a chat is attached to this account from elsewhere (e.g. another tab). */
export function subscribeMemberships(
  accountId: string,
  onInsert: (row: MembershipRow) => void,
): RealtimeChannel {
  return supabase
    .channel(`memberships-${accountId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_memberships', filter: `account_id=eq.${accountId}` },
      (payload) => onInsert(payload.new as MembershipRow),
    )
    .subscribe()
}

export function unsubscribe(channel: RealtimeChannel) {
  supabase.removeChannel(channel)
}
