<script setup lang="ts">
import { ref } from 'vue'
import { generateKeyPair, exportPublicKey, exportPrivateKey, jwkToUrlSafe } from '../lib/crypto'
import { joinSession } from '../api/session'
import { chatHash, navigate } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { logDebug } from '../debug'

const props = defineProps<{ sessionId: string }>()

const joining = ref(false)
const failed = ref(false)
const alreadyTaken = ref(false)
const personalLink = ref('')
const chatDestination = ref('')
const copied = ref(false)

async function join() {
  joining.value = true
  failed.value = false
  alreadyTaken.value = false
  try {
    const keyPair = await generateKeyPair()
    const [publicKey, privateKey] = await Promise.all([
      exportPublicKey(keyPair.publicKey),
      exportPrivateKey(keyPair.privateKey),
    ])

    const ok = await joinSession(props.sessionId, publicKey)
    if (!ok) {
      alreadyTaken.value = true
      return
    }

    const packedKey = jwkToUrlSafe(privateKey)
    chatDestination.value = chatHash(props.sessionId, 'joiner', packedKey)
    personalLink.value = `${location.origin}${location.pathname}${chatDestination.value}`
  } catch (err) {
    logDebug(`join failed: ${err}`, 'error')
    failed.value = true
  } finally {
    joining.value = false
  }
}

async function copyLink() {
  if (await copyToClipboard(personalLink.value)) {
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
}

function goToChat() {
  navigate(chatDestination.value)
}
</script>

<template>
  <div class="join">
    <template v-if="!personalLink">
      <p class="intro">
        You've been invited to an encrypted chat. Joining generates your own keypair in this
        browser — your private key never leaves it.
      </p>
      <button class="primary" :disabled="joining" @click="join">
        {{ joining ? 'Joining…' : 'Join chat' }}
      </button>
      <p v-if="alreadyTaken" class="error">
        This invite has already been used by someone else — ask for a fresh one.
      </p>
      <p v-else-if="failed" class="error">Couldn't join — check your connection and try again.</p>
    </template>

    <template v-else>
      <p class="intro">You're in. Save this link — it's how you reopen this chat later.</p>

      <div class="link-block">
        <label>Your personal link</label>
        <p class="hint">Carries your private key — use this to reopen this chat on this device.</p>
        <div class="link-row">
          <input readonly :value="personalLink" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copyLink">{{ copied ? 'Copied ✓' : 'Copy' }}</button>
        </div>
      </div>

      <button class="primary" @click="goToChat">Go to chat</button>
    </template>
  </div>
</template>

<style scoped>
.join {
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
