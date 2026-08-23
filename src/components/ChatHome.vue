<script setup lang="ts">
import { ref } from 'vue'
import { generateKeyPair, exportPublicKey, exportPrivateKey, jwkToUrlSafe } from '../lib/crypto'
import { createSession } from '../api/session'
import { chatHash, inviteHash, navigate } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { logDebug } from '../debug'

const starting = ref(false)
const failed = ref(false)
const personalLink = ref('')
const inviteLink = ref('')
const chatDestination = ref('')
const copiedPersonal = ref(false)
const copiedInvite = ref(false)

async function startChat() {
  starting.value = true
  failed.value = false
  try {
    const keyPair = await generateKeyPair()
    const [publicKey, privateKey] = await Promise.all([
      exportPublicKey(keyPair.publicKey),
      exportPrivateKey(keyPair.privateKey),
    ])

    const sessionId = await createSession(publicKey)
    if (!sessionId) {
      failed.value = true
      return
    }

    const packedKey = jwkToUrlSafe(privateKey)
    const base = `${location.origin}${location.pathname}`
    chatDestination.value = chatHash(sessionId, 'starter', packedKey)
    personalLink.value = `${base}${chatDestination.value}`
    inviteLink.value = `${base}${inviteHash(sessionId)}`
  } catch (err) {
    logDebug(`startChat failed: ${err}`, 'error')
    failed.value = true
  } finally {
    starting.value = false
  }
}

async function copyPersonal() {
  if (await copyToClipboard(personalLink.value)) {
    copiedPersonal.value = true
    setTimeout(() => (copiedPersonal.value = false), 1500)
  }
}

async function copyInvite() {
  if (await copyToClipboard(inviteLink.value)) {
    copiedInvite.value = true
    setTimeout(() => (copiedInvite.value = false), 1500)
  }
}

function goToChat() {
  navigate(chatDestination.value)
}
</script>

<template>
  <div class="home">
    <template v-if="!personalLink">
      <p class="intro">
        Start an end-to-end encrypted chat. Your keys are generated in this browser and never sent
        anywhere — only you can read your messages.
      </p>
      <button class="primary" :disabled="starting" @click="startChat">
        {{ starting ? 'Starting…' : 'Start a chat' }}
      </button>
      <p v-if="failed" class="error">
        Couldn't start a chat — check your connection and try again.
      </p>
    </template>

    <template v-else>
      <p class="intro">Your chat is ready. Save both links before you continue.</p>

      <div class="link-block">
        <label>Your personal link</label>
        <p class="hint">Carries your private key — use this to reopen this chat on this device.</p>
        <div class="link-row">
          <input readonly :value="personalLink" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copyPersonal">{{ copiedPersonal ? 'Copied ✓' : 'Copy' }}</button>
        </div>
      </div>

      <div class="link-block">
        <label>Invite link</label>
        <p class="hint">Send this to the other person so they can join.</p>
        <div class="link-row">
          <input readonly :value="inviteLink" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copyInvite">{{ copiedInvite ? 'Copied ✓' : 'Copy' }}</button>
        </div>
      </div>

      <button class="primary" @click="goToChat">Go to chat</button>
    </template>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 0;
}

.intro {
  color: var(--text-muted);
  margin: 0;
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
