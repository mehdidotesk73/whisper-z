import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { logDebug } from '../debug'

export type Role = 'starter' | 'joiner'

export interface SessionRow {
  id: string
  starter_public_key: string
  joiner_public_key: string | null
  created_at: string
}

export interface MessageRow {
  id: string
  session_id: string
  sender: Role
  ciphertext: string
  iv: string
  created_at: string
}

/** Creates the session row and returns its id, or null on failure. */
export async function createSession(starterPublicKey: JsonWebKey): Promise<string | null> {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ starter_public_key: JSON.stringify(starterPublicKey) })
    .select('id')
    .single()

  if (error) {
    logDebug(`createSession failed: ${error.message}`, 'error')
    return null
  }
  return data.id as string
}

/**
 * Registers the joiner's public key. Only succeeds the first time — a second
 * joiner hitting the same invite link gets `false` back rather than
 * overwriting the first joiner's key.
 */
export async function joinSession(sessionId: string, joinerPublicKey: JsonWebKey): Promise<boolean> {
  const { data, error } = await supabase
    .from('sessions')
    .update({ joiner_public_key: JSON.stringify(joinerPublicKey) })
    .eq('id', sessionId)
    .is('joiner_public_key', null)
    .select('id')

  if (error) {
    logDebug(`joinSession failed: ${error.message}`, 'error')
    return false
  }
  return (data?.length ?? 0) > 0
}

export async function fetchSession(sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await supabase.from('sessions').select('*').eq('id', sessionId).single()

  if (error) {
    logDebug(`fetchSession failed: ${error.message}`, 'error')
    return null
  }
  return data as SessionRow
}

/** Fires whenever the session row changes — used to notice the other side joining. */
export function subscribeSession(
  sessionId: string,
  onChange: (row: SessionRow) => void,
): RealtimeChannel {
  return supabase
    .channel(`session-${sessionId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (payload) => onChange(payload.new as SessionRow),
    )
    .subscribe()
}

export async function fetchMessages(sessionId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })

  if (error) {
    logDebug(`fetchMessages failed: ${error.message}`, 'error')
    return []
  }
  return data as MessageRow[]
}

export async function sendMessage(
  sessionId: string,
  sender: Role,
  ciphertext: string,
  iv: string,
): Promise<boolean> {
  const { error } = await supabase.from('messages').insert({ session_id: sessionId, sender, ciphertext, iv })

  if (error) {
    logDebug(`sendMessage failed: ${error.message}`, 'error')
    return false
  }
  return true
}

/** Fires for every new message inserted into this session. */
export function subscribeMessages(
  sessionId: string,
  onInsert: (row: MessageRow) => void,
): RealtimeChannel {
  return supabase
    .channel(`messages-${sessionId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${sessionId}` },
      (payload) => onInsert(payload.new as MessageRow),
    )
    .subscribe()
}

export function unsubscribe(channel: RealtimeChannel) {
  supabase.removeChannel(channel)
}
