import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { logDebug } from '../debug'
import type { SealedEnvelope } from '../lib/crypto'

// --- sessions: just an opaque container, no identifying data at all --------

export async function createSession(): Promise<string | null> {
  const { data, error } = await supabase.from('sessions').insert({}).select('id').single()

  if (error) {
    logDebug(`createSession failed: ${error.message}`, 'error')
    return null
  }
  return data.id as string
}

// --- session_access: "who can find this session, and with what key" -------
// Looked up by a derived lookup tag (see lib/crypto.ts deriveLookupTag), not
// by a real public key — that's the whole point: the database can see that
// a tag has N rows, never which sessions they point to.

export interface SessionAccessRow {
  id: string
  owner_pub: string
  ciphertext: string
  iv: string
  ephemeral_public_key: string
}

/** DB rows use snake_case; lib/crypto's SealedEnvelope uses camelCase. */
export function toEnvelope(row: { ciphertext: string; iv: string; ephemeral_public_key: string }): SealedEnvelope {
  return { ciphertext: row.ciphertext, iv: row.iv, ephemeralPublicKey: row.ephemeral_public_key }
}

export async function insertSessionAccess(ownerPub: string, envelope: SealedEnvelope): Promise<boolean> {
  const { error } = await supabase.from('session_access').insert({
    owner_pub: ownerPub,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    ephemeral_public_key: envelope.ephemeralPublicKey,
  })

  if (error) {
    logDebug(`insertSessionAccess failed: ${error.message}`, 'error')
    return false
  }
  return true
}

export async function fetchSessionAccessForOwner(ownerPub: string): Promise<SessionAccessRow[]> {
  const { data, error } = await supabase.from('session_access').select('*').eq('owner_pub', ownerPub)

  if (error) {
    logDebug(`fetchSessionAccessForOwner failed: ${error.message}`, 'error')
    return []
  }
  return data as SessionAccessRow[]
}

/** Fires when a new access row is added for this owner tag (e.g. an invite arriving). */
export function subscribeSessionAccess(
  ownerPub: string,
  onInsert: (row: SessionAccessRow) => void,
): RealtimeChannel {
  return supabase
    .channel(`session-access-${ownerPub}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'session_access', filter: `owner_pub=eq.${ownerPub}` },
      (payload) => onInsert(payload.new as SessionAccessRow),
    )
    .subscribe()
}

// --- join_access: a bearer link anyone holding its secret can redeem -------

export interface JoinAccessRow {
  id: string
  ciphertext: string
  iv: string
}

export async function createJoinAccess(envelope: { ciphertext: string; iv: string }): Promise<string | null> {
  const { data, error } = await supabase
    .from('join_access')
    .insert({ ciphertext: envelope.ciphertext, iv: envelope.iv })
    .select('id')
    .single()

  if (error) {
    logDebug(`createJoinAccess failed: ${error.message}`, 'error')
    return null
  }
  return data.id as string
}

export async function fetchJoinAccess(joinId: string): Promise<JoinAccessRow | null> {
  const { data, error } = await supabase.from('join_access').select('*').eq('id', joinId).single()

  if (error) {
    logDebug(`fetchJoinAccess failed: ${error.message}`, 'error')
    return null
  }
  return data as JoinAccessRow
}

/** Consumes a join link after a successful redemption, so it can't be used again. */
export async function deleteJoinAccess(joinId: string): Promise<boolean> {
  const { error } = await supabase.from('join_access').delete().eq('id', joinId)

  if (error) {
    logDebug(`deleteJoinAccess failed: ${error.message}`, 'error')
    return false
  }
  return true
}

// --- session_participants: the shared, plaintext "who's in this session" --
// Fine to be plaintext: within a session everyone already knows who else is
// in it. `display_name` is set for guests (a random name); left null for an
// account holder, whose current username is looked up live instead.

export interface ParticipantRow {
  id: string
  session_id: string
  public_key: string
  display_name: string | null
  created_at: string
}

export async function addParticipant(
  sessionId: string,
  publicKeyJson: string,
  displayName: string | null,
): Promise<boolean> {
  const { error } = await supabase
    .from('session_participants')
    .insert({ session_id: sessionId, public_key: publicKeyJson, display_name: displayName })

  if (error) {
    logDebug(`addParticipant failed: ${error.message}`, 'error')
    return false
  }
  return true
}

export async function fetchParticipants(sessionId: string): Promise<ParticipantRow[]> {
  const { data, error } = await supabase.from('session_participants').select('*').eq('session_id', sessionId)

  if (error) {
    logDebug(`fetchParticipants failed: ${error.message}`, 'error')
    return []
  }
  return data as ParticipantRow[]
}

export function subscribeParticipants(
  sessionId: string,
  onInsert: (row: ParticipantRow) => void,
): RealtimeChannel {
  return supabase
    .channel(`participants-${sessionId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'session_participants', filter: `session_id=eq.${sessionId}` },
      (payload) => onInsert(payload.new as ParticipantRow),
    )
    .subscribe()
}

// --- messages: encrypted with the session's shared key, sender embedded ---
// inside the plaintext rather than a column — see docs/system-design.md §3.

export interface MessageRow {
  id: string
  session_id: string
  ciphertext: string
  iv: string
  created_at: string
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

export async function sendMessage(sessionId: string, ciphertext: string, iv: string): Promise<boolean> {
  const { error } = await supabase.from('messages').insert({ session_id: sessionId, ciphertext, iv })

  if (error) {
    logDebug(`sendMessage failed: ${error.message}`, 'error')
    return false
  }
  return true
}

export function subscribeMessages(sessionId: string, onInsert: (row: MessageRow) => void): RealtimeChannel {
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
