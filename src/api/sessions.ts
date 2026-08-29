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

/**
 * Rewrites an existing session_access row's sealed payload in place — used
 * to merge a newly migrated guest identity into a row an account already
 * has for a session, rather than inserting a second row for the same
 * session (see migrateGuestSessionToAccount in api/sessionActions.ts).
 */
export async function updateSessionAccess(id: string, envelope: SealedEnvelope): Promise<boolean> {
  const { error } = await supabase
    .from('session_access')
    .update({ ciphertext: envelope.ciphertext, iv: envelope.iv, ephemeral_public_key: envelope.ephemeralPublicKey })
    .eq('id', id)

  if (error) {
    logDebug(`updateSessionAccess failed: ${error.message}`, 'error')
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

// --- join_access: a bearer link anyone holding its secret can redeem once --
// exactly once, and only within a short window — see claimJoinAccess below.

export interface JoinAccessRow {
  id: string
  ciphertext: string
  iv: string
  created_at: string
  consumed_at: string | null
}

export const JOIN_LINK_TTL_MS = 10 * 60 * 1000

export function isJoinAccessExpired(row: Pick<JoinAccessRow, 'created_at'>): boolean {
  return Date.now() - new Date(row.created_at).getTime() > JOIN_LINK_TTL_MS
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

/**
 * Read-only lookup — used to validate a link (exists, not already consumed,
 * not expired, secret matches) before showing "Join". Never mutates
 * anything, so merely opening a link — even one that's stale or already
 * used — can't itself grant access; only claimJoinAccess below can.
 */
export async function fetchJoinAccess(joinId: string): Promise<JoinAccessRow | null> {
  const { data, error } = await supabase.from('join_access').select('*').eq('id', joinId).maybeSingle()

  if (error) {
    logDebug(`fetchJoinAccess failed: ${error.message}`, 'error')
    return null
  }
  return data as JoinAccessRow | null
}

/**
 * Atomically consumes a join link: `UPDATE ... WHERE consumed_at IS NULL
 * RETURNING` is a single statement, so if two people click "Join" on the
 * same link at once, Postgres only lets one of them see `consumed_at IS
 * NULL` still true and win — the other's update matches zero rows and gets
 * null back. The row is marked, not deleted, so a later visit can still
 * tell "already used" apart from "never existed."
 */
export async function claimJoinAccess(joinId: string): Promise<JoinAccessRow | null> {
  const { data, error } = await supabase
    .from('join_access')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', joinId)
    .is('consumed_at', null)
    .select('*')
    .maybeSingle()

  if (error) {
    logDebug(`claimJoinAccess failed: ${error.message}`, 'error')
    return null
  }
  return data as JoinAccessRow | null
}

// --- session_participants: "who's in this session", encrypted with the --
// session's own shared key. `session_id` stays a plaintext lookup column —
// "this session has N participant rows" is the same accepted metadata leak
// as `messages.session_id` already being plaintext — but each row's public
// key is sealed inside `ciphertext`, symmetrically, with the exact same
// session key `messages` are encrypted with (see encryptText/decryptText in
// lib/crypto.ts — no ECDH, no ephemeral key needed: anyone who legitimately
// holds the session key is already a real participant). Without that key, a
// full database dump shows sessions exist and roughly how many people are
// in each, but never which public keys — closing a real gap the previous,
// plaintext `public_key` column left open: an account uses the same real
// key every time it joins a session, so a plaintext column here would have
// let anyone query "every session this public key has ever joined" directly,
// exactly the membership graph `session_access`'s lookup-tag design exists
// to hide. Display names are never stored here regardless; they're resolved
// per-message from `sender` instead (see docs/system-design.md §3).

export interface ParticipantRow {
  id: string
  session_id: string
  ciphertext: string
  iv: string
  created_at: string
}

export async function addParticipant(sessionId: string, ciphertext: string, iv: string): Promise<boolean> {
  const { error } = await supabase.from('session_participants').insert({ session_id: sessionId, ciphertext, iv })

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

// Loaded a window at a time (see MESSAGE_PAGE_DAYS) rather than the whole
// history at once — a session running for months would otherwise mean
// decrypting and rendering every message in it just to open the thread.

export const MESSAGE_PAGE_DAYS = 7

/**
 * `sinceISO` to `beforeISO` (or to now, if `beforeISO` is omitted — the
 * initial load's upper edge is simply "whatever exists right now," with
 * anything sent after that arriving through the realtime subscription
 * instead). `beforeISO` is only ever the previous window's own `sinceISO`,
 * so windows tile with no gap and no overlap.
 */
export async function fetchMessagesInRange(
  sessionId: string,
  sinceISO: string,
  beforeISO: string | null,
): Promise<MessageRow[]> {
  let query = supabase.from('messages').select('*').eq('session_id', sessionId).gte('created_at', sinceISO)
  if (beforeISO) query = query.lt('created_at', beforeISO)
  const { data, error } = await query.order('created_at', { ascending: true })

  if (error) {
    logDebug(`fetchMessagesInRange failed: ${error.message}`, 'error')
    return []
  }
  return data as MessageRow[]
}

/** Existence check backing the "Load more" button — cheap since it's a single indexed row, not a count. */
export async function hasMessagesBefore(sessionId: string, beforeISO: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('session_id', sessionId)
    .lt('created_at', beforeISO)
    .limit(1)

  if (error) {
    logDebug(`hasMessagesBefore failed: ${error.message}`, 'error')
    return false
  }
  return (data?.length ?? 0) > 0
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

/**
 * The latest message timestamp per session, for sorting a chat list by
 * recent activity — `created_at` is plaintext (existence/timing metadata,
 * same class of leak as everything else that's ever visible), so this
 * needs no decryption at all. Sessions with no messages yet are simply
 * absent from the result.
 */
export async function fetchLatestMessageTimes(sessionIds: string[]): Promise<Map<string, string>> {
  if (!sessionIds.length) return new Map()
  const { data, error } = await supabase
    .from('messages')
    .select('session_id, created_at')
    .in('session_id', sessionIds)
    .order('created_at', { ascending: false })

  if (error) {
    logDebug(`fetchLatestMessageTimes failed: ${error.message}`, 'error')
    return new Map()
  }

  const latest = new Map<string, string>()
  for (const row of data as { session_id: string; created_at: string }[]) {
    if (!latest.has(row.session_id)) latest.set(row.session_id, row.created_at)
  }
  return latest
}
