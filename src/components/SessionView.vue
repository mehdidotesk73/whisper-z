<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
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
  fetchParticipants,
  subscribeParticipants,
  createJoinAccess,
  unsubscribe,
  toEnvelope,
  type ParticipantRow,
} from '../api/sessions'
import type { SessionAccessPayload, JoinPayload, DecodedMessage } from '../lib/sessionTypes'
import { copyToClipboard } from '../lib/clipboard'
import { navigate, homeHash, joinHash } from '../lib/route'
import { currentAccount } from '../lib/auth'
import { logDebug } from '../debug'
import type { RealtimeChannel } from '@supabase/supabase-js'

// Either a guest personal-link key, or an account's session id (looked up
// against the account's own stable identity — see lib/auth.ts).
const props = defineProps<{ packedKey?: string; sessionId?: string }>()

type Status = 'loading' | 'ready' | 'not-found'
const status = ref<Status>('loading')

interface RenderedMessage {
  id: string
  mine: boolean
  senderName: string
  text: string
}

const messages = ref<RenderedMessage[]>([])
const draft = ref('')
const sending = ref(false)
const scrollAnchor = ref<HTMLElement>()
const composerTextarea = ref<HTMLTextAreaElement>()

let activeSessionId = ''
let sessionKey: CryptoKey | null = null
let sessionKeyJwk: JsonWebKey | null = null
let ownPublicKeyId = ''
const participantNames = new Map<string, string>() // public key JSON -> display name
const seenMessageIds = new Set<string>()
let messageChannel: RealtimeChannel | null = null
let participantChannel: RealtimeChannel | null = null

function nameFor(publicKeyJson: string): string {
  return participantNames.get(publicKeyJson) ?? 'Someone'
}

function applyParticipant(row: ParticipantRow) {
  participantNames.set(row.public_key, row.display_name ?? 'Someone')
}

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
    messages.value.push({
      id: row.id,
      mine: plain.sender === ownPublicKeyId,
      senderName: plain.sender === ownPublicKeyId ? 'You' : nameFor(plain.sender),
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
      ownPublicKeyId = currentAccount.value.publicKeyId
    } else if (props.packedKey) {
      const privateKeyJwk = unpackJwk(props.packedKey)
      privateKey = await importPrivateKey(privateKeyJwk)
      ownPublicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(privateKeyJwk))
    } else {
      status.value = 'not-found'
      return
    }

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

    const participants = await fetchParticipants(activeSessionId)
    for (const p of participants) applyParticipant(p)
    participantChannel = subscribeParticipants(activeSessionId, applyParticipant)

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
  if (participantChannel) unsubscribe(participantChannel)
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

async function toggleInvite() {
  showWarning.value = false
  showInvite.value = !showInvite.value
  if (showInvite.value && !inviteLink.value) await generateInvite()
}

async function copyInvite() {
  if (await copyToClipboard(inviteLink.value)) {
    copiedInvite.value = true
    setTimeout(() => (copiedInvite.value = false), 1500)
  }
}

// Warning only applies to a guest (packedKey) route — an account-backed
// (sessionId) route is recoverable via the account's own link instead.
const showWarning = ref(false)
const personalLink = props.packedKey ? `${location.origin}${location.pathname}#/session/${props.packedKey}` : ''
const copiedPersonal = ref(false)

function toggleWarning() {
  showInvite.value = false
  showWarning.value = !showWarning.value
}

async function copyPersonal() {
  if (await copyToClipboard(personalLink)) {
    copiedPersonal.value = true
    setTimeout(() => (copiedPersonal.value = false), 1500)
  }
}

function onDocClick(e: MouseEvent) {
  if (panelArea.value && !panelArea.value.contains(e.target as Node)) {
    showInvite.value = false
    showWarning.value = false
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

function goHome() {
  navigate(homeHash)
}
</script>

<template>
  <div class="session">
    <div class="top-bar">
      <button class="chip" @click="goHome">← Home</button>
      <button v-if="status === 'ready'" class="chip" @click.stop="toggleInvite">Invite</button>
      <button v-if="status === 'ready' && props.packedKey" class="chip warning" @click.stop="toggleWarning">⚠ Warning</button>
    </div>

    <div ref="panelArea">
      <div v-if="showInvite" class="link-block">
        <label>Invite link</label>
        <p class="hint">
          Send this to someone so they can join. It works once and expires in 10 minutes — generate
          a new one for the next person.
        </p>
        <div class="link-row">
          <input
            readonly
            :value="inviteLink || 'Generating…'"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button :disabled="!inviteLink" @click="copyInvite">{{ copiedInvite ? 'Copied ✓' : 'Copy' }}</button>
        </div>
        <button class="new-link" :disabled="!inviteLink" @click="generateInvite">New link, for another person</button>
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
    </div>

    <p v-if="status === 'loading'" class="status">Loading…</p>
    <p v-else-if="status === 'not-found'" class="status error">
      This session doesn't exist — check the link you followed.
    </p>

    <template v-else>
      <ul class="thread">
        <li v-if="!messages.length" class="empty">No messages yet — say hello.</li>
        <li v-for="m in messages" :key="m.id" :class="['bubble', m.mine ? 'mine' : 'theirs']">
          <span v-if="!m.mine" class="sender">{{ m.senderName }}</span>
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

.link-block label {
  font-weight: 600;
  font-size: 0.9rem;
}

.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
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
