<script setup lang="ts">
import { ref } from 'vue'
import { generateKeyPair, exportPublicKey, exportPrivateKey, canonicalPublicKeyId, packJwk } from '../lib/crypto'
import { createAccount } from '../api/accounts'
import { setCurrentAccount } from '../lib/auth'
import { accountHash, navigateReplace, homeHash } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { logDebug } from '../debug'

const emit = defineEmits<{ cancel: [] }>()

const username = ref('')
const creating = ref(false)
const error = ref('')
const accountLink = ref('')
const copied = ref(false)

async function submit() {
  const name = username.value.trim()
  if (!name || creating.value) return

  creating.value = true
  error.value = ''
  try {
    const identity = await generateKeyPair()
    const publicKeyId = canonicalPublicKeyId(await exportPublicKey(identity.publicKey))
    const account = await createAccount(name, publicKeyId)
    if (!account) {
      error.value = 'That username may already be taken — try another.'
      return
    }

    const packedKey = packJwk(await exportPrivateKey(identity.privateKey))
    setCurrentAccount(identity.privateKey, identity.publicKey, publicKeyId, account, packedKey)
    accountLink.value = `${location.origin}${location.pathname}${accountHash(packedKey)}`
  } catch (err) {
    logDebug(`createAccount failed: ${err}`, 'error')
    error.value = 'Something went wrong — check your connection and try again.'
  } finally {
    creating.value = false
  }
}

async function copyLink() {
  if (await copyToClipboard(accountLink.value)) {
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
}

function finish() {
  navigateReplace(homeHash)
}
</script>

<template>
  <div class="create-account">
    <template v-if="!accountLink">
      <p class="intro">
        An account keeps a chat list across every session you're part of, without a link to save
        for each one. Your keypair is still generated in this browser — nothing but the username
        and a public key ever reaches the server.
      </p>
      <label>Username</label>
      <input v-model="username" placeholder="Pick a username" @keydown.enter="submit" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="row">
        <button class="primary" :disabled="!username.trim() || creating" @click="submit">
          {{ creating ? 'Creating…' : 'Create account' }}
        </button>
        <button class="secondary" @click="emit('cancel')">Cancel</button>
      </div>
    </template>

    <template v-else>
      <div class="link-block warning-block">
        <p class="hint">
          Save this link now — it's the only way to open this account on another device or after
          clearing your browser. There's no password recovery.
        </p>
        <label>Your account link</label>
        <div class="link-row">
          <input readonly :value="accountLink" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copyLink">{{ copied ? 'Copied ✓' : 'Copy' }}</button>
        </div>
      </div>
      <button class="primary" @click="finish">Continue</button>
    </template>
  </div>
</template>

<style scoped>
.create-account {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem 0;
}

.intro {
  color: var(--text-muted);
  margin: 0;
}

label {
  font-weight: 600;
  font-size: 0.9rem;
}

input {
  padding: 0.6rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg);
  color: var(--text);
  font-size: 1rem;
}

.error {
  color: var(--danger);
  margin: 0;
}

.row {
  display: flex;
  gap: 0.5rem;
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
  padding: 0.75rem 1rem;
  min-height: 44px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  color: var(--text);
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
