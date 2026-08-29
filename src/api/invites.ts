import { supabase } from './supabase'
import { logDebug } from '../debug'

// --- session_invites: a pairwise-discoverable session invite ---------------
// See lib/crypto.ts's "Pairwise discoverable secrets" section and
// docs/system-design.md §3 for the full design. `tag` is a plaintext,
// indexed column — but it's the output of a hash of an ECDH shared secret
// between the inviter's and invitee's real keys, computable only by
// whoever holds one of the two matching private keys. A database dump sees
// opaque {tag, ciphertext} pairs; it can never attribute a row to a
// specific inviter or invitee, and no lookup ever happens over the network
// to find someone's key in the first place (that's exchanged out of band).

export interface InviteRow {
  id: string
  tag: string
  ciphertext: string
  iv: string
  created_at: string
}

export async function createInvite(tag: string, ciphertext: string, iv: string): Promise<string | null> {
  const { data, error } = await supabase.from('session_invites').insert({ tag, ciphertext, iv }).select('id').single()

  if (error) {
    logDebug(`createInvite failed: ${error.message}`, 'error')
    return null
  }
  return data.id as string
}

/** Every candidate tag an invitee has derived, checked in one indexed query — never a full-table scan. */
export async function fetchInvitesByTags(tags: string[]): Promise<InviteRow[]> {
  if (!tags.length) return []
  const { data, error } = await supabase.from('session_invites').select('*').in('tag', tags)

  if (error) {
    logDebug(`fetchInvitesByTags failed: ${error.message}`, 'error')
    return []
  }
  return data as InviteRow[]
}

/** Accept and reject are both just "delete the row" — whoever can derive its tag can identify it to delete. */
export async function deleteInvite(id: string): Promise<boolean> {
  const { error } = await supabase.from('session_invites').delete().eq('id', id)

  if (error) {
    logDebug(`deleteInvite failed: ${error.message}`, 'error')
    return false
  }
  return true
}
