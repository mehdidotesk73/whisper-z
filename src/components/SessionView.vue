<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  importPrivateKey,
  publicJwkFromPrivateJwk,
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
} from '../lib/crypto'
import {
  fetchSessionAccessForOwner,
  fetchMessages,
  sendMessage,
  subscribeMessages,
  createJoinAccess,
  unsubscribe,
  toEnvelope,
} from '../api/sessions'
import type { SessionAccessPayload, JoinPayload, DecodedMessage } from '../lib/sessionTypes'
import { copyToClipboard } from '../lib/clipboard'
import { navigate, homeHash, joinHash, mySessionHash, parseHash, extractHash } from '../lib/route'
import { currentAccount, loginWithPackedKey } from '../lib/auth'
import { fetchAccountByPublicKey } from '../api/accounts'
import { isIdentityMerged, migrateGuestSessionToAccount } from '../api/sessionActions'
import { createSessionInvite, rejectInvite } from '../api/inviteActions'
import { guestNameForKey, truncateName } from '../lib/guestName'
import { logDebug } from '../debug'
import Modal from './Modal.vue'
import type { RealtimeChannel } from '@supabase/supabase-js'

// Either a guest personal-link key, or an account's session id (looked up
// against the account's own stable identity — see lib/auth.ts).
const props = defineProps<{ packedKey?: string; sessionId?: string }>()

type Status = 'loading' | 'ready' | 'not-found'
const status = ref<Status>('loading')

interface RenderedMessage {
  id: string
  mine: boolean
  sender: string
  text: string
}

const messages = ref<RenderedMessage[]>([])
const draft = ref('')
const sending = ref(false)
const migrated = ref(false) // this guest session already has an account attached to it
const scrollAnchor = ref<HTMLElement>()
const composerTextarea = ref<HTMLTextAreaElement>()

let activeSessionId = ''
let sessionKey: CryptoKey | null = null
let sessionKeyJwk: JsonWebKey | null = null
// The identity used to SEND an invite from this session — same private key
// as everything else in onMounted, just held onto for inviteByKey().
let ownPrivateKey: CryptoKey | null = null
// The identity used to SEND: a guest's one-off key, or an account's real
// key (always — even for a migrated session, see onMounted below).
let ownPublicKeyId = ''
let ownRole: 'owner' | 'member' = 'member'
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
  if (participantNames.has(publicKeyId)) return
  participantNames.set(publicKeyId, guestNameForKey(publicKeyId)) // instant placeholder, also guards re-fetching
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

async function decodeAndAppend(row: { id: string; ciphertext: string; iv: string }) {
  if (seenMessageIds.has(row.id) || !sessionKey) return
  seenMessageIds.add(row.id)
  try {
    const json = await decryptText(sessionKey, { ciphertext: row.ciphertext, iv: row.iv })
    const plain = JSON.parse(json) as DecodedMessage
    resolveName(plain.sender)
    messages.value.push({
      id: row.id,
      mine: myKeys.has(plain.sender),
      sender: plain.sender,
      text: plain.text,
    })
    scrollToBottom()
  } catch (err) {
    logDebug(`Could not decrypt message ${row.id}: ${err}`, 'warn')
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
      myKeys = new Set([ownPublicKeyId])
    } else {
      status.value = 'not-found'
      return
    }
    ownPrivateKey = privateKey

    const ownerPub = await deriveLookupTag(privateKey, 'session-access')
    const rows = await fetchSessionAccessForOwner(ownerPub)
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
          break
        }
      }
    } else {
      access = await openSealed<SessionAccessPayload>(toEnvelope(rows[0]), privateKey)
    }
    if (!access) {
      status.value = 'not-found'
      return
    }
    activeSessionId = access.sessionId
    sessionKeyJwk = access.sessionKey
    sessionKey = await importSessionKey(access.sessionKey)
    ownRole = access.role
    if (props.sessionId) {
      // Always send as the account's real key, even for a migrated session
      // — that's what lets new messages resolve to the account's live
      // username for everyone. The pinned identityPublicKeyId (if any) only
      // extends "mine" to also cover messages sent before migration.
      ownPublicKeyId = currentAccount.value!.publicKeyId
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

    const existing = await fetchMessages(activeSessionId)
    for (const row of existing) await decodeAndAppend(row)

    status.value = 'ready'
    messageChannel = subscribeMessages(activeSessionId, decodeAndAppend)
  } catch (err) {
    logDebug(`Opening session failed: ${err}`, 'error')
    status.value = 'not-found'
  }
})

onBeforeUnmount(() => {
  if (messageChannel) unsubscribe(messageChannel)
})

async function send() {
  const text = draft.value.trim()
  if (!text || !sessionKey || sending.value) return

  sending.value = true
  try {
    const payload: DecodedMessage = { sender: ownPublicKeyId, text, createdAt: new Date().toISOString() }
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
  if (!sessionKeyJwk) return
  copiedInvite.value = false
  inviteLink.value = ''
  const secretBytes = generateJoinSecret()
  const joinKey = await importJoinKey(secretBytes)
  const payload: JoinPayload = { sessionId: activeSessionId, sessionKey: sessionKeyJwk }
  const { ciphertext, iv } = await encryptText(joinKey, JSON.stringify(payload))
  const joinId = await createJoinAccess({ ciphertext, iv })
  if (!joinId) return
  inviteLink.value = `${location.origin}${location.pathname}${joinHash(joinId, bytesToUrlSafe(secretBytes))}`
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
  if (!ownPrivateKey || !sessionKeyJwk) return
  const pasted = inviteByKeyInput.value.trim()
  if (!pasted) return

  invitingByKey.value = true
  inviteByKeyError.value = ''
  try {
    const targetPublicKeyJwk = unpackJwk(pasted)
    const payload: JoinPayload = { sessionId: activeSessionId, sessionKey: sessionKeyJwk }
    const created = await createSessionInvite(payload, ownPrivateKey, targetPublicKeyJwk)
    if (!created) {
      inviteByKeyError.value = 'Could not send the invite — try again.'
      return
    }
    lastInviteId.value = created.id
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
  if (!currentAccount.value || !sessionKeyJwk) return
  migrating.value = true
  migrateError.value = ''
  try {
    const ok = await migrateGuestSessionToAccount(
      activeSessionId,
      sessionKeyJwk,
      ownRole,
      ownPublicKeyId,
      currentAccount.value,
    )
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

// Invite menu: a small popover offering the two ways to invite, each
// opening its panel in a modal rather than inline.
const showInviteMenu = ref(false)

function toggleInviteMenu() {
  showInviteMenu.value = !showInviteMenu.value
}

async function openInviteModal() {
  showInviteMenu.value = false
  closeAllPanels()
  showInvite.value = true
  if (!inviteLink.value) await generateInvite()
}

function openInviteByKeyModal() {
  showInviteMenu.value = false
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
  showInviteMenu.value = false
}

function onDocClick(e: MouseEvent) {
  if (panelArea.value && !panelArea.value.contains(e.target as Node)) closeAllPanels()
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

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
        <div v-if="status === 'ready'" class="menu-wrap invite-menu-wrap">
          <button class="chip-ghost tone-blue" @click.stop="toggleInviteMenu">Invite ▾</button>
          <div v-if="showInviteMenu" class="menu-pop">
            <button class="menu-item" @click="openInviteModal">By join link</button>
            <button class="menu-item" @click="openInviteByKeyModal">By public key</button>
          </div>
        </div>
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

    <p v-if="status === 'loading'" class="status">Loading…</p>
    <p v-else-if="status === 'not-found'" class="status error">
      This session doesn't exist — check the link you followed.
    </p>

    <template v-else>
      <ul class="thread">
        <li v-if="!messages.length" class="empty">No messages yet — say hello.</li>
        <li v-for="m in messages" :key="m.id" :class="['bubble', m.mine ? 'mine' : 'theirs']">
          <span v-if="!m.mine" class="sender">{{ nameFor(m.sender) }}</span>
          {{ m.text }}
        </li>
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
  padding: 0.35rem 0.7rem;
  min-height: 40px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
}

.chip-ghost.tone-neutral {
  color: var(--text-muted);
}

.chip-ghost.tone-blue {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.menu-wrap {
  position: relative;
}

.invite-menu-wrap {
  margin-left: auto;
}

.menu-pop {
  position: absolute;
  top: calc(100% + 0.3rem);
  right: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  min-width: 10rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
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

.bubble {
  max-width: 80%;
  padding: 0.55rem 0.75rem;
  border-radius: 0.9rem;
  word-break: break-word;
  white-space: pre-wrap;
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
