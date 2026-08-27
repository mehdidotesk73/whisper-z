<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { currentAccount, logout } from '../lib/auth'
import { fetchMemberships, createMembership, subscribeMemberships, unsubscribe } from '../api/account'
import { fetchSession } from '../api/session'
import { buildChatListItem, type ChatListItem } from '../api/chatList'
import { startNewChat } from '../api/chatActions'
import { importPrivateKey, urlSafeToJwk, wrapPrivateKey } from '../lib/crypto'
import { chatHash, inviteHash, navigate, parseHash, extractHash } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { logDebug } from '../debug'
import type { RealtimeChannel } from '@supabase/supabase-js'

const account = currentAccount.value!

const loading = ref(true)
const chats = ref<ChatListItem[]>([])
let membershipChannel: RealtimeChannel | null = null

async function loadChats() {
  loading.value = true
  const memberships = await fetchMemberships(account.id)
  const items = await Promise.all(memberships.map((m) => buildChatListItem(account, m)))
  chats.value = items.filter((item): item is ChatListItem => item !== null)
  loading.value = false
}

onMounted(async () => {
  await loadChats()
  membershipChannel = subscribeMemberships(account.id, async (row) => {
    const item = await buildChatListItem(account, row)
    if (item && !chats.value.some((c) => c.membershipId === item.membershipId)) {
      chats.value.unshift(item)
    }
  })
})

onBeforeUnmount(() => {
  if (membershipChannel) unsubscribe(membershipChannel)
})

function openChat(chat: ChatListItem) {
  if (!chat.packedKey) return
  navigate(chatHash(chat.sessionId, chat.role, chat.packedKey))
}

// Start a new chat
const creatingChat = ref(false)
const starting = ref(false)
const startFailed = ref(false)
const newChatInvite = ref('')
const newChatDestination = ref('')
const copiedInvite = ref(false)

async function startChat() {
  starting.value = true
  startFailed.value = false
  try {
    const result = await startNewChat(account)
    if (!result) {
      startFailed.value = true
      return
    }
    newChatDestination.value = chatHash(result.sessionId, 'starter', result.packedKey)
    newChatInvite.value = `${location.origin}${location.pathname}${inviteHash(result.sessionId)}`
  } finally {
    starting.value = false
  }
}

async function copyNewChatInvite() {
  if (await copyToClipboard(newChatInvite.value)) {
    copiedInvite.value = true
    setTimeout(() => (copiedInvite.value = false), 1500)
  }
}

function goToNewChat() {
  navigate(newChatDestination.value)
}

// Attach an existing chat (paste its personal link) to this account
const attachLink = ref('')
const attachError = ref('')
const attaching = ref(false)

async function attachPastedLink() {
  attachError.value = ''
  if (!attachLink.value.trim()) return

  const hash = extractHash(attachLink.value)
  const parsed = parseHash(hash)
  if (parsed.name !== 'chat') {
    attachError.value = "Paste your personal chat link (the one with your private key) — not an invite link."
    return
  }

  attaching.value = true
  try {
    const session = await fetchSession(parsed.sessionId)
    if (!session) {
      attachError.value = "That chat doesn't exist."
      return
    }

    const privateKeyJwk = urlSafeToJwk(parsed.packedKey)
    const privateKey = await importPrivateKey(privateKeyJwk)
    const wrapped = await wrapPrivateKey(privateKeyJwk, privateKey, account.publicKey)
    const ok = await createMembership(account.id, parsed.sessionId, parsed.role, 'Chat', wrapped)
    if (!ok) {
      attachError.value = 'Could not save that chat — try again.'
      return
    }

    attachLink.value = ''
    await loadChats()
  } catch (err) {
    logDebug(`attachPastedLink failed: ${err}`, 'error')
    attachError.value = 'Could not save that chat — try again.'
  } finally {
    attaching.value = false
  }
}
</script>

<template>
  <div class="account-home">
    <div class="account-bar">
      <span class="username">@{{ account.username }}</span>
      <button class="logout-btn" @click="logout">Log out</button>
    </div>

    <ul class="chat-list">
      <li v-if="loading" class="empty">Loading your chats…</li>
      <li v-else-if="!chats.length" class="empty">No chats yet — start one below.</li>
      <li
        v-for="chat in chats"
        :key="chat.membershipId"
        class="chat-item"
        :class="{ disabled: !chat.packedKey }"
        @click="openChat(chat)"
      >
        <span class="chat-title">{{ chat.title }}</span>
        <span class="chat-other">{{ chat.otherLabel }}</span>
      </li>
    </ul>

    <div class="divider"><span>or</span></div>

    <template v-if="!creatingChat">
      <button class="secondary" @click="creatingChat = true">+ Start a new chat</button>
    </template>
    <template v-else-if="!newChatInvite">
      <button class="primary" :disabled="starting" @click="startChat">
        {{ starting ? 'Starting…' : 'Start a new chat' }}
      </button>
      <p v-if="startFailed" class="error">Couldn't start a chat — check your connection and try again.</p>
    </template>
    <div v-else class="link-block">
      <label>Invite link</label>
      <p class="hint">Send this to the other person so they can join.</p>
      <div class="link-row">
        <input readonly :value="newChatInvite" @focus="($event.target as HTMLInputElement).select()" />
        <button @click="copyNewChatInvite">{{ copiedInvite ? 'Copied ✓' : 'Copy' }}</button>
      </div>
      <button class="primary" @click="goToNewChat">Go to chat</button>
    </div>

    <div class="divider"><span>or</span></div>

    <div class="link-block">
      <label>Add an existing chat</label>
      <p class="hint">Paste a personal chat link to save it to this account.</p>
      <div class="link-row">
        <input
          v-model="attachLink"
          placeholder="Paste link here"
          :disabled="attaching"
          @keydown.enter="attachPastedLink"
        />
        <button :disabled="attaching" @click="attachPastedLink">Save</button>
      </div>
      <p v-if="attachError" class="error">{{ attachError }}</p>
    </div>
  </div>
</template>

<style scoped>
.account-home {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 0;
}

.account-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.username {
  font-weight: 600;
}

.logout-btn {
  padding: 0.3rem 0.7rem;
  min-height: 44px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.logout-btn:hover {
  color: var(--text);
  border-color: var(--danger);
}

.chat-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 1rem 0;
}

.chat-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.75rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  cursor: pointer;
}

.chat-item:hover {
  border-color: var(--accent-blue);
}

.chat-item.disabled {
  opacity: 0.6;
  cursor: default;
}

.chat-title {
  font-weight: 600;
}

.chat-other {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.primary {
  padding: 0.75rem 1rem;
  min-height: 44px;
  background: var(--accent-blue);
  color: #fff;
  border: none;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 1rem;
}

.primary:disabled {
  opacity: 0.6;
}

.secondary {
  padding: 0.65rem 1rem;
  min-height: 44px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  color: var(--text);
  font-weight: 600;
  font-size: 0.95rem;
}

.secondary:hover {
  border-color: var(--accent-blue);
}

.error {
  color: var(--danger);
  margin: 0;
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
</style>
