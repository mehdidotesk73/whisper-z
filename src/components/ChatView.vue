<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  importPrivateKey,
  importPublicKey,
  deriveSharedKey,
  encryptText,
  decryptText,
  urlSafeToJwk,
} from '../lib/crypto'
import {
  fetchSession,
  subscribeSession,
  fetchMessages,
  sendMessage,
  subscribeMessages,
  unsubscribe,
  type SessionRow,
  type MessageRow,
  type Role,
} from '../api/session'
import { copyToClipboard } from '../lib/clipboard'
import { navigate, homeHash } from '../lib/route'
import { logDebug } from '../debug'
import type { RealtimeChannel } from '@supabase/supabase-js'

const props = defineProps<{ sessionId: string; role: Role; packedKey: string }>()

type Status = 'loading' | 'waiting' | 'ready' | 'not-found' | 'error'
const status = ref<Status>('loading')

interface DecodedMessage {
  id: string
  mine: boolean
  text: string
  createdAt: string
}

const messages = ref<DecodedMessage[]>([])
const draft = ref('')
const sending = ref(false)
const scrollAnchor = ref<HTMLElement>()
const inviteLink = computed(() => `${location.origin}${location.pathname}#/join/${props.sessionId}`)
const copiedInvite = ref(false)

let sharedKey: CryptoKey | null = null
let sessionChannel: RealtimeChannel | null = null
let messageChannel: RealtimeChannel | null = null
const seenIds = new Set<string>()

function otherPublicKeyJson(row: SessionRow): string | null {
  return props.role === 'starter' ? row.joiner_public_key : row.starter_public_key
}

async function scrollToBottom() {
  await nextTick()
  scrollAnchor.value?.scrollIntoView({ block: 'end' })
}

async function decodeAndAppend(row: MessageRow) {
  if (seenIds.has(row.id) || !sharedKey) return
  seenIds.add(row.id)
  try {
    const text = await decryptText(sharedKey, { ciphertext: row.ciphertext, iv: row.iv })
    messages.value.push({ id: row.id, mine: row.sender === props.role, text, createdAt: row.created_at })
    scrollToBottom()
  } catch (err) {
    logDebug(`Could not decrypt message ${row.id}: ${err}`, 'warn')
  }
}

async function startChatting(row: SessionRow) {
  const otherKeyJson = otherPublicKeyJson(row)
  if (!otherKeyJson) return

  const myPrivateKey = await importPrivateKey(urlSafeToJwk(props.packedKey))
  const otherPublicKey = await importPublicKey(JSON.parse(otherKeyJson))
  sharedKey = await deriveSharedKey(myPrivateKey, otherPublicKey)

  const existing = await fetchMessages(props.sessionId)
  for (const row of existing) await decodeAndAppend(row)

  status.value = 'ready'
  messageChannel = subscribeMessages(props.sessionId, decodeAndAppend)
}

onMounted(async () => {
  const row = await fetchSession(props.sessionId)
  if (!row) {
    status.value = 'not-found'
    return
  }

  if (otherPublicKeyJson(row)) {
    await startChatting(row)
    return
  }

  status.value = 'waiting'
  sessionChannel = subscribeSession(props.sessionId, async (updated) => {
    if (otherPublicKeyJson(updated)) {
      if (sessionChannel) unsubscribe(sessionChannel)
      sessionChannel = null
      await startChatting(updated)
    }
  })
})

onBeforeUnmount(() => {
  if (sessionChannel) unsubscribe(sessionChannel)
  if (messageChannel) unsubscribe(messageChannel)
})

async function send() {
  const text = draft.value.trim()
  if (!text || !sharedKey || sending.value) return

  sending.value = true
  try {
    const { ciphertext, iv } = await encryptText(sharedKey, text)
    const ok = await sendMessage(props.sessionId, props.role, ciphertext, iv)
    if (ok) draft.value = ''
  } finally {
    sending.value = false
  }
}

async function copyInvite() {
  if (await copyToClipboard(inviteLink.value)) {
    copiedInvite.value = true
    setTimeout(() => (copiedInvite.value = false), 1500)
  }
}

function goHome() {
  navigate(homeHash)
}
</script>

<template>
  <div class="chat">
    <button class="home-link" @click="goHome">← Home</button>

    <p v-if="status === 'loading'" class="status">Loading…</p>

    <p v-else-if="status === 'not-found'" class="status error">
      This chat doesn't exist — check the link you followed.
    </p>

    <div v-else-if="status === 'waiting'" class="waiting">
      <p class="status">Waiting for the other person to join…</p>
      <div class="link-row">
        <input readonly :value="inviteLink" @focus="($event.target as HTMLInputElement).select()" />
        <button @click="copyInvite">{{ copiedInvite ? 'Copied ✓' : 'Copy invite' }}</button>
      </div>
    </div>

    <template v-else-if="status === 'ready'">
      <ul class="thread">
        <li v-if="!messages.length" class="empty">No messages yet — say hello.</li>
        <li v-for="m in messages" :key="m.id" :class="['bubble', m.mine ? 'mine' : 'theirs']">
          {{ m.text }}
        </li>
        <li ref="scrollAnchor" class="anchor"></li>
      </ul>

      <form class="composer" @submit.prevent="send">
        <textarea
          v-model="draft"
          rows="1"
          placeholder="Message…"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <button type="submit" :disabled="!draft.trim() || sending">Send</button>
      </form>
    </template>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.5rem 0;
  min-height: 50vh;
}

.status {
  color: var(--text-muted);
  text-align: center;
}

.status.error {
  color: var(--danger);
}

.home-link {
  align-self: flex-start;
  padding: 0.3rem 0.1rem;
  min-height: 44px;
  background: none;
  border: none;
  color: var(--accent-blue);
  font-size: 0.9rem;
  font-weight: 600;
}

.waiting {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: center;
}

.link-row {
  display: flex;
  gap: 0.4rem;
  width: 100%;
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
  max-height: 8rem;
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
