<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  importPrivateKey,
  importPublicKey,
  publicJwkFromPrivateJwk,
  publicKeyFromCanonicalId,
  canonicalPublicKeyId,
  deriveLookupTag,
  openSealed,
  importSessionKey,
  encryptText,
  decryptText,
  generateJoinSecret,
  importJoinKey,
  bytesToUrlSafe,
  unpackJwk,
  derivePersonalSigningKeyPair,
  importEcdsaPublicKey,
  importEcdsaPrivateKey,
  signData,
  verifySignature,
} from '../lib/crypto'
import {
  fetchSessionAccessForOwner,
  fetchMessagesInRange,
  hasMessagesBefore,
  MESSAGE_PAGE_DAYS,
  sendMessage,
  subscribeMessages,
  createJoinAccess,
  unsubscribe,
  toEnvelope,
  fetchParticipants,
  subscribeParticipants,
  type ParticipantRow,
  type SessionAccessRow,
} from '../api/sessions'
import type {
  SessionAccessPayload,
  JoinPayload,
  DecodedMessage,
  CapabilityGrantEntry,
  InviteSentEntry,
  JoinedEntry,
  SessionLogEntry,
} from '../lib/sessionTypes'
import { copyToClipboard } from '../lib/clipboard'
import { navigate, homeHash, joinHash, mySessionHash, parseHash, extractHash } from '../lib/route'
import { currentAccount, loginWithPackedKey } from '../lib/auth'
import { fetchAccountByPublicKey } from '../api/accounts'
import {
  isIdentityMerged,
  migrateGuestSessionToAccount,
  parseParticipantPayload,
  hasCapability,
  grantCapability,
  acceptCapabilityGrant,
  logInviteSent,
  inviteSentSigningInput,
  joinedSigningInput,
} from '../api/sessionActions'
import { createSessionInvite, rejectInvite } from '../api/inviteActions'
import { guestNameForKey, truncateName } from '../lib/guestName'
import { logDebug } from '../debug'
import { useOutsideClick } from '../lib/useOutsideClick'
import Modal from './Modal.vue'
import MenuButton from './MenuButton.vue'
import type { RealtimeChannel } from '@supabase/supabase-js'

// Either a guest personal-link key, or an account's session id (looked up
// against the account's own stable identity — see lib/auth.ts).
const props = defineProps<{ packedKey?: string; sessionId?: string }>()

type Status = 'loading' | 'ready' | 'not-found'
const status = ref<Status>('loading')

// A capability-grant entry renders as a centered system tag, never a chat
// bubble — see docs/system-design.md §3's "Stage E" entry ("kind decides
// rendering").
// A system-tag variant carries the raw ids/facts, not a pre-built display
// string — resolveName's real-username fetch is async, so baking a name
// into a fixed string at decode time can freeze in a not-yet-resolved
// placeholder forever. systemTagText (below) computes the text at render
// time instead, calling nameFor live so it stays in sync as names resolve —
// exactly like a bubble's sender label already does.
type RenderedMessage =
  | { id: string; kind: 'message'; mine: boolean; sender: string; text: string }
  | { id: string; kind: 'capability-grant'; granteePublicKeyId: string; capability: string }
  | { id: string; kind: 'invite-sent'; sender: string; inviteePublicKeyId: string }
  | { id: string; kind: 'joined'; sender: string; via: 'link' | 'invite' }

const messages = ref<RenderedMessage[]>([])
const draft = ref('')
const sending = ref(false)
const migrated = ref(false) // this guest session already has an account attached to it
const scrollAnchor = ref<HTMLElement>()
const composerTextarea = ref<HTMLTextAreaElement>()
const threadEl = ref<HTMLElement>()

// Message history loads one MESSAGE_PAGE_DAYS-wide window at a time rather
// than all at once — windowStart is the earliest instant currently loaded;
// "Load more" shifts it back by another window. hasMoreHistory is only ever
// set from an explicit existence check (see api/sessions.ts's
// hasMessagesBefore), never assumed, so the button simply doesn't appear
// once there's nothing earlier to fetch.
const windowStart = ref('')
const hasMoreHistory = ref(false)
const loadingMore = ref(false)

let activeSessionId = ''
let sessionKey: CryptoKey | null = null
let sessionKeyJwk: JsonWebKey | null = null
// The identity used to SEND an invite from this session — same private key
// as everything else in onMounted, just held onto for inviteByKey().
let ownPrivateKey: CryptoKey | null = null
// The identity used to SEND: a guest's one-off key, or an account's real
// key (always — even for a migrated session, see onMounted below).
let ownPublicKeyId = ''
let ownPublicKey: CryptoKey | null = null
// The whole opened SessionAccessPayload for this route's identity — kept
// around (not just the few fields destructured above) so migrateToAccount
// and the invite builders below can forward Stage E's admin key fields
// without re-fetching/re-opening anything. See sessionActions.ts's
// migrateGuestSessionToAccount doc comment for why passing the whole
// payload, not a narrower parameter list, matters.
let ownAccessPayload: SessionAccessPayload | null = null
// The raw row backing ownAccessPayload — needed for its `id`, the only
// piece acceptCapabilityGrant needs beyond the payload itself, to self-write
// a newly recovered capability back into this exact row.
let ownAccessRow: SessionAccessRow | null = null
// Reactive mirror of hasCapability(ownAccessPayload, 'invite') — the plain
// `let` above isn't template-reactive, and this can change mid-session (a
// grant arriving live), unlike everything else read from ownAccessPayload,
// which is only ever consulted at the moment an action button is clicked.
const canInvite = ref(false)
// True only when this identity is both the owner AND actually holds admin
// key material — a session created before Stage E has role 'owner' but no
// admin keys at all, so role alone isn't enough to safely offer the Grant
// button (see onMounted).
const canGrant = ref(false)
// Other participants seen so far (session_participants + anyone who's sent
// a message), for the admin-only "grant invite access" panel — never
// includes ownPublicKeyId. capabilityGrantsSeen tracks which of them
// already hold 'invite', purely from watching capability-grant entries go
// by in the log, so the panel doesn't offer to re-grant something already
// granted.
const otherParticipantIds = ref<string[]>([])
const grantedCapabilities = reactive(new Map<string, Set<string>>()) // publicKeyId -> capabilities granted
// A message sent from here on is signed with the sender's own personal
// signing key (derived, not stored — see lib/crypto.ts) and verified against
// the sender's signingPublicKey published in their session_participants
// row. Populated from the initial participant fetch below and kept live via
// subscribeParticipants; a sender with no entry here yet (a legacy
// participant row, or a race with a very recently joined sender) is
// rendered unverified rather than dropped — see "Signing Is Opportunistic,
// Not Yet Enforced" in docs/experience.md for the honest limit that leaves.
const participantSigningKeys = new Map<string, CryptoKey>()
let participantChannel: RealtimeChannel | null = null

/**
 * A plain pull, not just a wait on subscribeParticipants' live push —
 * called again right before showing the grant panel, since that's the one
 * place staleness is directly visible to the admin (a member who joined
 * moments ago missing from the list they're about to act on), and a fresh
 * fetch is trivially correct regardless of whether this session's realtime
 * event actually arrives promptly.
 */
async function refreshParticipants() {
  for (const row of await fetchParticipants(activeSessionId)) await registerParticipantRow(row)
}

async function registerParticipantRow(row: Pick<ParticipantRow, 'ciphertext' | 'iv'>) {
  if (!sessionKey) return
  try {
    const decrypted = await decryptText(sessionKey, { ciphertext: row.ciphertext, iv: row.iv })
    const parsed = parseParticipantPayload(decrypted)
    if (parsed.signingPublicKey) {
      participantSigningKeys.set(parsed.publicKeyId, await importEcdsaPublicKey(parsed.signingPublicKey))
    }
    if (parsed.publicKeyId !== ownPublicKeyId && !otherParticipantIds.value.includes(parsed.publicKeyId)) {
      otherParticipantIds.value.push(parsed.publicKeyId)
      // Without this, a participant who hasn't sent a message yet (or been
      // the subject of a grant — the only other place resolveName gets
      // called) shows up here under its deterministic guest-style fallback
      // name forever, never its real account username, since resolveName's
      // account lookup only ever runs for a key it's actually been asked
      // about.
      resolveName(parsed.publicKeyId)
    }
  } catch {
    // Not decryptable with this session's key — shouldn't happen, ignore.
  }
}

/** Same field order at sign time and verify time — see signOutgoingMessage/decodeMessage below. */
function messageSigningInput(sender: string, text: string, createdAt: string): string {
  return JSON.stringify({ kind: 'message', sender, text, createdAt })
}
// Which sender keys count as "mine" for bubble styling — usually just
// ownPublicKeyId, but a migrated session's account also privately
// recognizes its old, pinned guest key as its own (see identityPublicKeyId
// in lib/sessionTypes.ts).
let myKeys = new Set<string>()
// Reactive mirror of the guest keys folded into myKeys (never includes
// ownPublicKeyId itself) — kept separate from the plain Set above so the
// hot per-message `.has()` check in decodeAndAppend stays cheap, while this
// still drives the "logged in as" aliases panel reactively.
const sessionAliasKeys = ref<string[]>([])

// Sender display names are resolved per-message from `sender` alone, live
// against `accounts`, with a deterministic (no-lookup) fallback for a key
// that isn't one — see lib/guestName.ts and docs/system-design.md §3. This
// is why a migrated identity's old messages keep the guest's name while
// its new ones correctly show the account's current username: nothing
// here treats them specially, both are just "resolve this sender key."
const participantNames = reactive(new Map<string, string>())

function nameFor(publicKeyId: string): string {
  return truncateName(participantNames.get(publicKeyId) ?? guestNameForKey(publicKeyId))
}

function resolveName(publicKeyId: string) {
  const placeholder = guestNameForKey(publicKeyId)
  // A cached value that's still exactly the placeholder means no account
  // lookup has ever actually succeeded for this key yet — try again. A null
  // result from fetchAccountByPublicKey means either "this really is a
  // guest with no account" or "the request itself failed" (a dropped
  // connection, a flaky mobile network), and those are indistinguishable
  // from here; retrying on every call this key is asked about again (once
  // per message/tag mentioning it) self-heals from the second case at
  // near-zero cost, instead of permanently mistaking a transient failure
  // for a settled "no account" answer the way a one-shot guard would.
  const current = participantNames.get(publicKeyId)
  if (current !== undefined && current !== placeholder) return // already resolved to a real account name
  participantNames.set(publicKeyId, placeholder)
  fetchAccountByPublicKey(publicKeyId).then((account) => {
    if (account) participantNames.set(publicKeyId, account.username)
  })
}

const seenMessageIds = new Set<string>()
let messageChannel: RealtimeChannel | null = null

async function scrollToBottom() {
  await nextTick()
  scrollAnchor.value?.scrollIntoView({ block: 'end' })
}

/**
 * Self-accepts a capability grant addressed to this identity (a no-op if it
 * isn't), then renders the grant as a system tag for everyone regardless —
 * the grant itself is visible to and verifiable by the whole session, only
 * the sealed secret inside it is private to the grantee. See
 * sessionActions.ts's acceptCapabilityGrant and CapabilityGrantEntry's own
 * doc comment.
 */
async function handleCapabilityGrant(id: string, entry: CapabilityGrantEntry): Promise<RenderedMessage> {
  let existing = grantedCapabilities.get(entry.granteePublicKeyId)
  if (!existing) {
    existing = new Set()
    grantedCapabilities.set(entry.granteePublicKeyId, existing)
  }
  existing.add(entry.capability)

  if (
    entry.granteePublicKeyId === ownPublicKeyId &&
    ownAccessRow &&
    ownAccessPayload &&
    ownPrivateKey &&
    ownPublicKey &&
    !hasCapability(ownAccessPayload, entry.capability)
  ) {
    const updated = await acceptCapabilityGrant(
      entry,
      ownPublicKeyId,
      ownPrivateKey,
      ownPublicKey,
      ownAccessRow,
      ownAccessPayload,
    )
    if (updated) {
      ownAccessPayload = updated
      if (entry.capability === 'invite') canInvite.value = true
    } else {
      logDebug(`Could not accept capability grant ${id}: signature or seal did not check out`, 'warn')
    }
  }

  resolveName(entry.granteePublicKeyId)
  return { id, kind: 'capability-grant', granteePublicKeyId: entry.granteePublicKeyId, capability: entry.capability }
}

/**
 * Shared opportunistic-verification policy for anything signed with a
 * sender's personal signing key (messages, invite-sent, joined — everything
 * except capability grants, which are admin-signed instead): a sender with
 * no known signing key yet renders unverified rather than being dropped
 * (see participantSigningKeys' doc comment above), but a signature that
 * fails to verify against a key we DO know is a real forgery signal.
 */
async function verifyOpportunistic(sender: string, signature: string, input: string): Promise<boolean> {
  const signingKey = participantSigningKeys.get(sender)
  if (!signingKey) return true
  return verifySignature(signingKey, signature, input)
}

async function handleInviteSent(id: string, entry: InviteSentEntry): Promise<RenderedMessage | null> {
  const input = inviteSentSigningInput(entry)
  if (!(await verifyOpportunistic(entry.sender, entry.signature, input))) {
    logDebug(`Dropped invite-sent entry ${id}: signature did not verify for sender ${entry.sender}`, 'warn')
    return null
  }
  resolveName(entry.sender)
  resolveName(entry.inviteePublicKeyId)
  return { id, kind: 'invite-sent', sender: entry.sender, inviteePublicKeyId: entry.inviteePublicKeyId }
}

async function handleJoined(id: string, entry: JoinedEntry): Promise<RenderedMessage | null> {
  const input = joinedSigningInput(entry)
  if (!(await verifyOpportunistic(entry.sender, entry.signature, input))) {
    logDebug(`Dropped joined entry ${id}: signature did not verify for sender ${entry.sender}`, 'warn')
    return null
  }
  resolveName(entry.sender)
  return { id, kind: 'joined', sender: entry.sender, via: entry.via }
}

/** Computed at render time (template calls this live), not baked in at decode time — see RenderedMessage's doc comment for why that distinction matters. */
function systemTagText(m: Extract<RenderedMessage, { kind: 'capability-grant' | 'invite-sent' | 'joined' }>): string {
  if (m.kind === 'capability-grant') {
    const name = nameFor(m.granteePublicKeyId)
    return m.capability === 'invite' ? `${name} can now send invites` : `${name} was granted "${m.capability}" access`
  }
  if (m.kind === 'invite-sent') return `${nameFor(m.sender)} invited ${nameFor(m.inviteePublicKeyId)}`
  return `${nameFor(m.sender)} joined by ${m.via === 'invite' ? 'invite' : 'join link'}`
}

async function decodeLogEntry(row: { id: string; ciphertext: string; iv: string }): Promise<RenderedMessage | null> {
  if (seenMessageIds.has(row.id) || !sessionKey) return null
  seenMessageIds.add(row.id)
  try {
    const json = await decryptText(sessionKey, { ciphertext: row.ciphertext, iv: row.iv })
    const plain = JSON.parse(json) as SessionLogEntry

    if (plain.kind === 'capability-grant') return await handleCapabilityGrant(row.id, plain)
    if (plain.kind === 'invite-sent') return await handleInviteSent(row.id, plain)
    if (plain.kind === 'joined') return await handleJoined(row.id, plain)

    // A legacy message (sent before Stage E) has no kind/signature at all —
    // still trusted, exactly as it always was; nothing here retroactively
    // distrusts history it can't verify. A new-shape message with a
    // signature that fails to verify against its claimed sender's known
    // signing key IS dropped — that's the actual forgery case this closes.
    // A sender with no known signing key yet (legacy participant row, or a
    // race with a just-joined sender) renders unverified rather than being
    // dropped — see participantSigningKeys' doc comment above.
    if (plain.kind === 'message' && plain.signature) {
      const input = messageSigningInput(plain.sender, plain.text, plain.createdAt)
      if (!(await verifyOpportunistic(plain.sender, plain.signature, input))) {
        logDebug(`Dropped message ${row.id}: signature did not verify for sender ${plain.sender}`, 'warn')
        return null
      }
    }

    resolveName(plain.sender)
    return { id: row.id, kind: 'message', mine: myKeys.has(plain.sender), sender: plain.sender, text: plain.text }
  } catch (err) {
    logDebug(`Could not decrypt session_log entry ${row.id}: ${err}`, 'warn')
    return null
  }
}

async function decodeAndAppend(row: { id: string; ciphertext: string; iv: string }) {
  const decoded = await decodeLogEntry(row)
  if (!decoded) return
  messages.value.push(decoded)
  scrollToBottom()
}

/**
 * Older history, loaded on demand — prepended above what's already shown
 * instead of appended, and the scroll position is adjusted by exactly the
 * height the prepended content added, so whatever the user was already
 * looking at stays put instead of jumping as the thread grows above it.
 */
async function loadMore() {
  if (loadingMore.value || !hasMoreHistory.value || !sessionKey) return
  loadingMore.value = true
  try {
    const el = threadEl.value
    const scrollHeightBefore = el?.scrollHeight ?? 0
    const scrollTopBefore = el?.scrollTop ?? 0

    const newWindowStart = new Date(
      new Date(windowStart.value).getTime() - MESSAGE_PAGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()
    const older = await fetchMessagesInRange(activeSessionId, newWindowStart, windowStart.value)
    const decoded: RenderedMessage[] = []
    for (const row of older) {
      const msg = await decodeLogEntry(row)
      if (msg) decoded.push(msg)
    }
    messages.value.unshift(...decoded)
    windowStart.value = newWindowStart
    hasMoreHistory.value = await hasMessagesBefore(activeSessionId, newWindowStart)

    await nextTick()
    if (el) el.scrollTop = scrollTopBefore + (el.scrollHeight - scrollHeightBefore)
  } finally {
    loadingMore.value = false
  }
}

onMounted(async () => {
  try {
    let privateKey: CryptoKey
    if (props.sessionId) {
      if (!currentAccount.value) {
        status.value = 'not-found'
        return
      }
      privateKey = currentAccount.value.privateKey
      // ownPublicKeyId is set below once `access` is decrypted — a migrated
      // guest session pins it to the original guest key, not the account's.
    } else if (props.packedKey) {
      const privateKeyJwk = unpackJwk(props.packedKey)
      privateKey = await importPrivateKey(privateKeyJwk)
      ownPublicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(privateKeyJwk))
      ownPublicKey = await importPublicKey(publicJwkFromPrivateJwk(privateKeyJwk))
      myKeys = new Set([ownPublicKeyId])
    } else {
      status.value = 'not-found'
      return
    }
    ownPrivateKey = privateKey

    const ownerTag = await deriveLookupTag(privateKey, 'session-access')
    const rows = await fetchSessionAccessForOwner(ownerTag)
    if (!rows.length) {
      status.value = 'not-found'
      return
    }

    let access: SessionAccessPayload | null = null
    if (props.sessionId) {
      // An account's tag can hold many sessions — find the one this route names.
      for (const row of rows) {
        const candidate = await openSealed<SessionAccessPayload>(toEnvelope(row), privateKey)
        if (candidate.sessionId === props.sessionId) {
          access = candidate
          ownAccessRow = row
          break
        }
      }
    } else {
      access = await openSealed<SessionAccessPayload>(toEnvelope(rows[0]), privateKey)
      ownAccessRow = rows[0]
    }
    if (!access) {
      status.value = 'not-found'
      return
    }
    activeSessionId = access.sessionId
    sessionKeyJwk = access.sessionKey
    sessionKey = await importSessionKey(access.sessionKey)
    ownAccessPayload = access
    canInvite.value = hasCapability(access, 'invite')
    // A session created before Stage E shipped has role 'owner' but no
    // admin key material at all — "can grant" needs both, not just the
    // role, or the button below would offer something that silently does
    // nothing when clicked (the same class of bug as an earlier, unrelated
    // modal issue this project already hit once).
    canGrant.value = access.role === 'owner' && !!access.adminEcdhPrivateKey && !!access.adminSigningPrivateKey

    if (props.sessionId) {
      // Always send as the account's real key, even for a migrated session
      // — that's what lets new messages resolve to the account's live
      // username for everyone. The pinned identityPublicKeyId (if any) only
      // extends "mine" to also cover messages sent before migration.
      ownPublicKeyId = currentAccount.value!.publicKeyId
      ownPublicKey = currentAccount.value!.publicKey
      myKeys = new Set([ownPublicKeyId, ...(access.identityPublicKeyIds ?? [])])
      sessionAliasKeys.value = access.identityPublicKeyIds ?? []
    } else if (currentAccount.value) {
      // Viewing a guest link while already logged in — check whether *this*
      // guest identity specifically has already been merged in, so "Add to
      // account" doesn't offer to redo something that's done. Narrower than
      // "does the account have any access to this session at all": it might,
      // from an unrelated direct join, without this guest visit being linked.
      migrated.value = await isIdentityMerged(currentAccount.value, activeSessionId, ownPublicKeyId)
    }

    // Populate participantSigningKeys (and otherParticipantIds) before
    // loading any messages below, so the very first render can verify
    // signatures rather than treating everyone as "no known key yet." Must
    // come after ownPublicKeyId is resolved above — registerParticipantRow
    // filters "not me" against it, and until this point (for an
    // account-backed route) it's still empty, which used to let the admin's
    // own name leak into the "grant invite access" panel's participant list.
    await refreshParticipants()
    participantChannel = subscribeParticipants(activeSessionId, registerParticipantRow)

    windowStart.value = new Date(Date.now() - MESSAGE_PAGE_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const existing = await fetchMessagesInRange(activeSessionId, windowStart.value, null)
    for (const row of existing) await decodeAndAppend(row)
    hasMoreHistory.value = await hasMessagesBefore(activeSessionId, windowStart.value)

    status.value = 'ready'
    messageChannel = subscribeMessages(activeSessionId, decodeAndAppend)
  } catch (err) {
    logDebug(`Opening session failed: ${err}`, 'error')
    status.value = 'not-found'
  }
})

onBeforeUnmount(() => {
  if (messageChannel) unsubscribe(messageChannel)
  if (participantChannel) unsubscribe(participantChannel)
})

async function send() {
  const text = draft.value.trim()
  if (!text || !sessionKey || !ownPrivateKey || sending.value) return

  sending.value = true
  try {
    const createdAt = new Date().toISOString()
    const signingKey = await derivePersonalSigningKeyPair(ownPrivateKey)
    const signature = await signData(signingKey, messageSigningInput(ownPublicKeyId, text, createdAt))
    const payload: DecodedMessage = { kind: 'message', sender: ownPublicKeyId, text, createdAt, signature }
    const { ciphertext, iv } = await encryptText(sessionKey, JSON.stringify(payload))
    const ok = await sendMessage(activeSessionId, ciphertext, iv)
    if (ok) {
      draft.value = ''
      await nextTick()
      resizeComposer()
    }
  } finally {
    sending.value = false
  }
}

const isTouchDevice = window.matchMedia('(pointer: coarse)').matches

function onComposerKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || isTouchDevice || e.shiftKey) return
  e.preventDefault()
  send()
}

function resizeComposer() {
  const el = composerTextarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// Invite and Warning panels: opening one closes the other, and clicking
// anywhere outside this whole area closes whichever is open.
const panelArea = ref<HTMLElement>()
const showInvite = ref(false)
const inviteLink = ref('')
const copiedInvite = ref(false)

async function generateInvite() {
  if (!sessionKeyJwk || !canInvite.value) return
  copiedInvite.value = false
  inviteLink.value = ''
  try {
    const secretBytes = generateJoinSecret()
    const joinKey = await importJoinKey(secretBytes)
    const payload: JoinPayload = {
      sessionId: activeSessionId,
      sessionKey: sessionKeyJwk,
      adminEcdhPublicKey: ownAccessPayload?.adminEcdhPublicKey,
      adminSigningPublicKey: ownAccessPayload?.adminSigningPublicKey,
    }
    const { ciphertext, iv } = await encryptText(joinKey, JSON.stringify(payload))
    const joinId = await createJoinAccess({ ciphertext, iv })
    if (!joinId) return
    inviteLink.value = `${location.origin}${location.pathname}${joinHash(joinId, bytesToUrlSafe(secretBytes))}`
  } catch (err) {
    logDebug(`generateInvite failed: ${err}`, 'error')
  }
}

async function copyInvite() {
  if (await copyToClipboard(inviteLink.value)) {
    copiedInvite.value = true
    setTimeout(() => (copiedInvite.value = false), 1500)
  }
}

// Invite by key: add an existing account directly, using a public key
// exchanged out of band (physically) rather than a shareable link — see
// api/inviteActions.ts and lib/crypto.ts's "Pairwise discoverable secrets"
// section for why this never involves a server-side lookup of any kind.
const showInviteByKey = ref(false)
const inviteByKeyInput = ref('')
const invitingByKey = ref(false)
const inviteByKeyError = ref('')
const lastInviteId = ref<string | null>(null)
const lastInviteRecipient = ref('')
const undoingInvite = ref(false)

async function sendInviteByKey() {
  if (!ownPrivateKey || !sessionKeyJwk || !canInvite.value) return
  const pasted = inviteByKeyInput.value.trim()
  if (!pasted) return

  invitingByKey.value = true
  inviteByKeyError.value = ''
  try {
    const targetPublicKeyJwk = unpackJwk(pasted)
    const payload: JoinPayload = {
      sessionId: activeSessionId,
      sessionKey: sessionKeyJwk,
      adminEcdhPublicKey: ownAccessPayload?.adminEcdhPublicKey,
      adminSigningPublicKey: ownAccessPayload?.adminSigningPublicKey,
    }
    const created = await createSessionInvite(payload, ownPrivateKey, targetPublicKeyJwk)
    if (!created) {
      inviteByKeyError.value = 'Could not send the invite — try again.'
      return
    }
    lastInviteId.value = created.id
    if (sessionKey) {
      await logInviteSent(activeSessionId, sessionKey, ownPrivateKey, ownPublicKeyId, canonicalPublicKeyId(targetPublicKeyJwk))
    }
    // The inviter already holds this exact key (they just pasted it), so
    // naming who it belongs to here reveals nothing new to anyone else.
    const targetAccount = await fetchAccountByPublicKey(canonicalPublicKeyId(targetPublicKeyJwk))
    lastInviteRecipient.value = targetAccount?.username ?? 'that key'
    inviteByKeyInput.value = ''
  } catch (err) {
    logDebug(`sendInviteByKey failed: ${err}`, 'error')
    inviteByKeyError.value = "That doesn't look like a public key — check you copied the whole thing."
  } finally {
    invitingByKey.value = false
  }
}

/**
 * Not a real cancel — an undo. It only works while this exact invite is
 * still in memory, right here, right after sending; refresh the page and
 * there's nothing left to undo (see rejectInvite's doc comment — the row
 * itself has no owner reference for a later session to reconstruct).
 */
async function undoLastInvite() {
  if (!lastInviteId.value) return
  undoingInvite.value = true
  try {
    await rejectInvite(lastInviteId.value)
    lastInviteId.value = null
    lastInviteRecipient.value = ''
  } finally {
    undoingInvite.value = false
  }
}

// Warning only applies to a guest (packedKey) route that hasn't been
// migrated to an account — an account-backed (sessionId) route, or a
// migrated guest route, is recoverable via the account's own link instead.
const showWarning = ref(false)
const personalLink = props.packedKey ? `${location.origin}${location.pathname}#/session/${props.packedKey}` : ''
const copiedPersonal = ref(false)

function toggleWarning() {
  const opening = !showWarning.value
  closeAllPanels()
  showWarning.value = opening
}

async function copyPersonal() {
  if (await copyToClipboard(personalLink)) {
    copiedPersonal.value = true
    setTimeout(() => (copiedPersonal.value = false), 1500)
  }
}

// "Add to account" only applies to a guest (packedKey) route, and only
// before it's been migrated once (checked in onMounted for anyone already
// logged in; migrating always safely no-ops a second time regardless).
const showMigrate = ref(false)
const migrating = ref(false)
const migrateError = ref('')
const migrateAccountLinkInput = ref('')

function toggleMigrate() {
  const opening = !showMigrate.value
  closeAllPanels()
  showMigrate.value = opening
  migrateError.value = ''
}

async function migrateToAccount() {
  if (!currentAccount.value || !ownAccessPayload) return
  migrating.value = true
  migrateError.value = ''
  try {
    const ok = await migrateGuestSessionToAccount(ownAccessPayload, ownPublicKeyId, currentAccount.value)
    if (!ok) {
      migrateError.value = 'Could not add this session to your account — try again.'
      return
    }
    migrated.value = true
    showMigrate.value = false
    // Navigate to the account-backed view as the confirmation that this
    // worked — otherwise nothing visibly changes and it looks like the
    // click did nothing but log someone in.
    navigate(mySessionHash(activeSessionId))
  } catch (err) {
    logDebug(`migrateToAccount failed: ${err}`, 'error')
    migrateError.value = 'Could not add this session to your account — try again.'
  } finally {
    migrating.value = false
  }
}

async function loginThenMigrate() {
  migrateError.value = ''
  const pasted = migrateAccountLinkInput.value.trim()
  if (!pasted) return

  const parsed = parseHash(extractHash(pasted))
  if (parsed.name !== 'account') {
    migrateError.value = "That doesn't look like an account link — check you copied the whole thing."
    return
  }

  const ok = await loginWithPackedKey(parsed.packedKey)
  if (!ok) {
    migrateError.value = "That account link didn't work — check you copied the whole thing."
    return
  }
  await migrateToAccount()
}

// "Logged in as" + this session's aliases — only meaningful on an
// account-backed (sessionId) route; a guest route's identity has no
// separate "logged in as" concept. Reuses sessionAliasKeys/nameFor, both
// already populated to render the thread — no new fetch. Adopting an alias
// itself now lives on AccountHome's "Account" menu (see
// api/sessionActions.ts's adoptGuestIdentity) — it works from anywhere, not
// just from inside the session it belongs to, so it no longer needs a
// button here at all.
const showAliases = ref(false)

function toggleAliases() {
  const opening = !showAliases.value
  closeAllPanels()
  showAliases.value = opening
}

// Admin-only: grant another participant the 'invite' capability (Stage E).
// Visible only when ownAccessPayload.role === 'owner' — see the template.
const showGrant = ref(false)
const grantingTo = ref<string | null>(null)
const grantError = ref('')

async function toggleGrant() {
  const opening = !showGrant.value
  closeAllPanels()
  showGrant.value = opening
  grantError.value = ''
  if (opening) await refreshParticipants()
}

function hasBeenGrantedInvite(participantId: string): boolean {
  return grantedCapabilities.get(participantId)?.has('invite') ?? false
}

async function grantInviteTo(participantId: string) {
  if (!sessionKey || !ownAccessPayload?.adminEcdhPrivateKey || !ownAccessPayload.adminSigningPrivateKey) {
    // canGrant being true should already guarantee this — a visible error
    // rather than a silent no-op if it somehow doesn't, so a click never
    // just appears to do nothing (see canGrant's doc comment in onMounted).
    grantError.value = 'This session has no admin keys to grant with — it may predate this feature.'
    return
  }
  grantingTo.value = participantId
  grantError.value = ''
  try {
    const adminEcdhPrivateKey = await importPrivateKey(ownAccessPayload.adminEcdhPrivateKey)
    const adminSigningPrivateKey = await importEcdsaPrivateKey(ownAccessPayload.adminSigningPrivateKey)
    const granteePublicKeyJwk = publicKeyFromCanonicalId(participantId)
    const ok = await grantCapability(
      activeSessionId,
      sessionKey,
      adminEcdhPrivateKey,
      adminSigningPrivateKey,
      granteePublicKeyJwk,
      'invite',
    )
    if (!ok) grantError.value = 'Could not send the grant — try again.'
  } catch (err) {
    logDebug(`grantInviteTo failed: ${err}`, 'error')
    grantError.value = 'Could not send the grant — try again.'
  } finally {
    grantingTo.value = null
  }
}

// Invite menu: a small popover offering the two ways to invite, each
// opening its panel in a modal rather than inline. The popover itself is
// MenuButton (see components/MenuButton.vue) — it owns closing itself and
// running the selected option's action together, so there's nothing here to
// get out of sync.
async function openInviteModal() {
  closeAllPanels()
  showInvite.value = true
  if (!inviteLink.value) await generateInvite()
}

function openInviteByKeyModal() {
  closeAllPanels()
  showInviteByKey.value = true
  inviteByKeyError.value = ''
}

function closeAllPanels() {
  showInvite.value = false
  showInviteByKey.value = false
  showWarning.value = false
  showMigrate.value = false
  showAliases.value = false
  showGrant.value = false
}

// Warning/Migrate are inline panels that actually live inside panelArea's
// DOM subtree, so outside-click is the only thing that closes them. The
// three Modal-backed panels (Invite by link, Invite by key, Aliases) render
// as siblings *after* panelArea closes, not inside it — Modal.vue already
// closes itself correctly on its own backdrop click (`@click.self`), so
// wiring the *same* outside-click listener to close them too was treating
// "clicked anywhere inside the modal" as "clicked outside panelArea" and
// closing it instantly, before a tap on the input or a button ever landed.
// closeAllPanels() itself is still right for "opening one closes the
// others" (see toggleWarning/toggleMigrate/toggleAliases/openInvite*Modal
// above) — only the outside-click trigger needed to be scoped down.
function closeInlinePanels() {
  showWarning.value = false
  showMigrate.value = false
}

useOutsideClick(panelArea, closeInlinePanels)

function goHome() {
  navigate(homeHash)
}
</script>

<template>
  <div class="session">
    <div ref="panelArea">
      <div class="top-bar-row">
        <button class="chip-ghost tone-neutral" @click="goHome">← Home</button>
      </div>

      <div class="top-bar-row identity-row">
        <span
          v-if="status === 'ready' && props.sessionId && currentAccount"
          class="whoami-text"
          @click.stop="toggleAliases"
        >
          Signed in as <strong>{{ currentAccount.account.username }}</strong>
        </span>
        <MenuButton v-if="status === 'ready' && canInvite" label="Invite ▾" tone="tone-blue" class="invite-menu-wrap">
          <template #default="{ select }">
            <button class="menu-item" @click="select(openInviteModal)">By join link</button>
            <button class="menu-item" @click="select(openInviteByKeyModal)">By public key</button>
          </template>
        </MenuButton>
        <button v-if="status === 'ready' && canGrant" class="chip-ghost tone-neutral" @click.stop="toggleGrant">
          Grant access ▾
        </button>
      </div>

      <div class="top-bar">
        <button v-if="status === 'ready' && props.packedKey && !migrated" class="chip" @click.stop="toggleMigrate">
          + Add to account
        </button>
        <button v-if="status === 'ready' && props.packedKey && !migrated" class="chip warning" @click.stop="toggleWarning">⚠ Warning</button>
      </div>

      <div v-if="showWarning" class="link-block warning-block">
        <p class="hint">
          This session is only accessible using your personal link below. If you close this tab
          without saving it, you'll lose access permanently — there's no password recovery.
        </p>
        <label>Your personal link</label>
        <div class="link-row">
          <input readonly :value="personalLink" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copyPersonal">{{ copiedPersonal ? 'Copied ✓' : 'Copy' }}</button>
        </div>
      </div>

      <div v-if="showMigrate" class="link-block">
        <template v-if="currentAccount">
          <p class="hint">
            Adds this session to <strong>{{ currentAccount.account.username }}</strong
            >'s chat list. Nothing about this thread changes — this is just another way to reach it.
          </p>
          <button class="primary" :disabled="migrating" @click="migrateToAccount">
            {{ migrating ? 'Adding…' : `Add to ${currentAccount.account.username}'s account` }}
          </button>
        </template>
        <template v-else>
          <label>Add to an account</label>
          <p class="hint">Paste your account link to sign in and add this session to its chat list.</p>
          <input
            v-model="migrateAccountLinkInput"
            placeholder="Paste your account link"
            @keydown.enter="loginThenMigrate"
          />
          <button class="primary" :disabled="migrating || !migrateAccountLinkInput.trim()" @click="loginThenMigrate">
            {{ migrating ? 'Adding…' : 'Log in & add' }}
          </button>
        </template>
        <p v-if="migrateError" class="error">{{ migrateError }}</p>
      </div>
    </div>

    <Modal :open="showInvite" title="Invite link" @close="showInvite = false">
      <p class="hint">
        Send this to someone so they can join. It works once and expires in 10 minutes — generate a
        new one for the next person.
      </p>
      <div class="link-row">
        <input readonly :value="inviteLink || 'Generating…'" @focus="($event.target as HTMLInputElement).select()" />
        <button :disabled="!inviteLink" @click="copyInvite">{{ copiedInvite ? 'Copied ✓' : 'Copy' }}</button>
      </div>
      <button class="new-link" :disabled="!inviteLink" @click="generateInvite">New link, for another person</button>
    </Modal>

    <Modal :open="showInviteByKey" title="Invite by key" @close="showInviteByKey = false">
      <p class="hint">
        Paste a public key someone shared with you directly (in person, or however you already
        trust) to add them to this session — no link needed.
      </p>
      <input v-model="inviteByKeyInput" placeholder="Paste their public key" @keydown.enter="sendInviteByKey" />
      <button class="primary" :disabled="invitingByKey || !inviteByKeyInput.trim()" @click="sendInviteByKey">
        {{ invitingByKey ? 'Sending…' : 'Send invite' }}
      </button>
      <p v-if="inviteByKeyError" class="error">{{ inviteByKeyError }}</p>
      <div v-if="lastInviteId" class="hint">
        Invite sent to {{ lastInviteRecipient }}.
        <button class="new-link" :disabled="undoingInvite" @click="undoLastInvite">
          {{ undoingInvite ? 'Undoing…' : 'Undo' }}
        </button>
      </div>
    </Modal>

    <Modal :open="showAliases" title="Your aliases in this session" @close="showAliases = false">
      <p v-if="sessionAliasKeys.length" class="hint">Messages from these senders in this thread are also you:</p>
      <ul v-if="sessionAliasKeys.length" class="alias-list">
        <li v-for="key in sessionAliasKeys" :key="key">{{ nameFor(key) }}</li>
      </ul>
      <p v-else class="hint">
        No other aliases adopted into this session yet — adopt one from your account's "Account" menu.
      </p>
    </Modal>

    <Modal :open="showGrant" title="Grant invite access" @close="showGrant = false">
      <p class="hint">Let someone else in this session send invites too, without giving them full admin.</p>
      <ul v-if="otherParticipantIds.length" class="alias-list">
        <li v-for="id in otherParticipantIds" :key="id" class="grant-row">
          <span>{{ nameFor(id) }}</span>
          <span v-if="hasBeenGrantedInvite(id)" class="hint">Already granted</span>
          <button v-else class="new-link" :disabled="grantingTo === id" @click="grantInviteTo(id)">
            {{ grantingTo === id ? 'Granting…' : 'Grant invite access' }}
          </button>
        </li>
      </ul>
      <p v-else class="hint">No one else has joined this session yet.</p>
      <p v-if="grantError" class="error">{{ grantError }}</p>
    </Modal>

    <p v-if="status === 'loading'" class="status">Loading…</p>
    <p v-else-if="status === 'not-found'" class="status error">
      This session doesn't exist — check the link you followed.
    </p>

    <template v-else>
      <ul ref="threadEl" class="thread">
        <li v-if="hasMoreHistory" class="load-more-row">
          <button class="load-more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </li>
        <li v-if="!messages.length" class="empty">No messages yet — say hello.</li>
        <template v-for="m in messages" :key="m.id">
          <li v-if="m.kind !== 'message'" class="system-tag">{{ systemTagText(m) }}</li>
          <li v-else :class="['bubble', m.mine ? 'mine' : 'theirs']">
            <span v-if="!m.mine" class="sender">{{ nameFor(m.sender) }}</span>
            {{ m.text }}
          </li>
        </template>
        <li ref="scrollAnchor" class="anchor"></li>
      </ul>

      <form class="composer" @submit.prevent="send">
        <textarea
          ref="composerTextarea"
          v-model="draft"
          rows="1"
          placeholder="Message…"
          @keydown="onComposerKeydown"
          @input="resizeComposer"
        ></textarea>
        <button type="submit" :disabled="!draft.trim() || sending">Send</button>
      </form>
    </template>
  </div>
</template>

<style scoped>
.session {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.5rem 0;
  min-height: 50vh;
}

.top-bar {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.top-bar-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.identity-row {
  justify-content: space-between;
}

.whoami-text {
  color: var(--text-muted);
  font-size: 0.85rem;
  cursor: pointer;
}

.whoami-text:hover {
  color: var(--text);
}

.chip {
  padding: 0.4rem 0.8rem;
  min-height: 44px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 600;
}

.chip:hover {
  border-color: var(--accent-blue);
}

.chip.warning {
  border-color: var(--danger);
  color: var(--danger);
}

.chip-ghost {
  padding: 0.28rem 0.65rem;
  min-height: 30px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.2;
}

.chip-ghost.tone-neutral {
  color: var(--text-muted);
}

.invite-menu-wrap {
  margin-left: auto;
}

.menu-item {
  padding: 0.7rem 0.9rem;
  min-height: 44px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  font-size: 0.85rem;
}

.menu-item:hover {
  background: var(--bg-elev-2);
}

.status {
  color: var(--text-muted);
  text-align: center;
}

.status.error {
  color: var(--danger);
}

.link-block {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.75rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.warning-block {
  border-color: var(--danger);
}

.link-block label,
.modal-body label {
  font-weight: 600;
  font-size: 0.9rem;
}

.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.alias-list {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.85rem;
}

.link-row {
  display: flex;
  gap: 0.4rem;
}

.link-row input {
  flex: 1;
  min-width: 0;
  padding: 0.5rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg);
  color: var(--text);
  font-size: 0.85rem;
}

.link-row button {
  padding: 0 0.75rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-elev-2);
  color: var(--text);
  white-space: nowrap;
}

.new-link {
  align-self: flex-start;
  padding: 0.3rem 0;
  background: none;
  border: none;
  color: var(--accent-blue);
  font-size: 0.8rem;
  text-decoration: underline;
}

.new-link:disabled {
  opacity: 0.6;
  text-decoration: none;
}

.link-block input,
.modal-body input {
  padding: 0.6rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg);
  color: var(--text);
  font-size: 0.9rem;
}

.link-block .primary,
.modal-body .primary {
  align-self: flex-start;
  padding: 0.6rem 1rem;
  min-height: 44px;
  background: var(--accent-blue);
  color: #fff;
  border: none;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 0.9rem;
}

.link-block .primary:disabled,
.modal-body .primary:disabled {
  opacity: 0.6;
}

.link-block .error,
.modal-body .error {
  color: var(--danger);
  margin: 0;
  font-size: 0.85rem;
}

.thread {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1;
  overflow-y: auto;
  max-height: 55vh;
}

.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 1rem 0;
}

.load-more-row {
  display: flex;
  justify-content: center;
  padding: 0.25rem 0;
}

.load-more {
  padding: 0.35rem 0.8rem;
  min-height: 36px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.load-more:disabled {
  opacity: 0.6;
}

.bubble {
  max-width: 80%;
  padding: 0.55rem 0.75rem;
  border-radius: 0.9rem;
  word-break: break-word;
  white-space: pre-wrap;
}

.system-tag {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--text-muted);
  font-size: 0.75rem;
  text-align: center;
}

.system-tag::before,
.system-tag::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.grant-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0;
}

.sender {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 0.15rem;
}

.bubble.theirs {
  align-self: flex-start;
  background: var(--bg-elev);
  border: 1px solid var(--border);
}

.bubble.mine {
  align-self: flex-end;
  background: var(--accent-blue);
  color: #fff;
}

.anchor {
  height: 1px;
}

.composer {
  display: flex;
  gap: 0.4rem;
  align-items: flex-end;
}

.composer textarea {
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 50vh;
  overflow-y: auto;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 1rem;
}

.composer button {
  padding: 0 1rem;
  min-height: 44px;
  background: var(--accent-blue);
  color: #fff;
  border: none;
  border-radius: 0.6rem;
  font-weight: 600;
}

.composer button:disabled {
  opacity: 0.5;
}
</style>
