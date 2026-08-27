<script setup lang="ts">
import { ref } from 'vue'
import { generateKeyPair, exportPublicKey, exportPrivateKey, jwkToUrlSafe } from '../lib/crypto'
import { createAccount } from '../api/account'
import { loginWithCredential } from '../lib/auth'
import { accountHash } from '../lib/route'
import { copyToClipboard } from '../lib/clipboard'
import { logDebug } from '../debug'

defineEmits<{ back: [] }>()

const username = ref('')
const creating = ref(false)
const error = ref('')
const accountLink = ref('')
const accountId = ref('')
const packedKey = ref('')
const copied = ref(false)

async function create() {
  const name = username.value.trim()
  if (!name) return

  creating.value = true
  error.value = ''
  try {
    const keyPair = await generateKeyPair()
    const [publicKey, privateKey] = await Promise.all([
      exportPublicKey(keyPair.publicKey),
      exportPrivateKey(keyPair.privateKey),
    ])

    const result = await createAccount(name, publicKey)
    if (!result.ok) {
      error.value =
        result.reason === 'taken'
          ? 'That username is taken — try another.'
          : "Couldn't create an account — check your connection and try again."
      return
    }

    accountId.value = result.account.id
    packedKey.value = jwkToUrlSafe(privateKey)
    accountLink.value = `${location.origin}${location.pathname}${accountHash(accountId.value, packedKey.value)}`
  } catch (err) {
    logDebug(`createAccount failed: ${err}`, 'error')
    error.value = "Couldn't create an account — check your connection and try again."
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

function goToChats() {
  loginWithCredential(accountId.value, packedKey.value)
}
</script>

<template>
  <div class="create-account">
    <template v-if="!accountLink">
      <button class="back-link" @click="$emit('back')">← Back</button>

      <p class="intro">
        Pick a username. It's just a label other people see next to your chats — not a public key,
        not a login, and it doesn't need to be secret.
      </p>

      <div class="link-row">
        <input
          v-model="username"
          placeholder="Username"
          :disabled="creating"
          @keydown.enter="create"
        />
        <button class="primary" :disabled="creating || !username.trim()" @click="create">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </template>

    <template v-else>
      <p class="intro">Account created. Save this link before you continue.</p>

      <div class="link-block">
        <label>Your account link</label>
        <p class="hint">
          Carries your account's private key — this is how you log in on this or any other device.
          There's no password and no recovery: lose this link and the account (and every chat in it)
          is gone for good.
        </p>
        <div class="link-row">
          <input readonly :value="accountLink" @focus="($event.target as HTMLInputElement).select()" />
          <button @click="copyLink">{{ copied ? 'Copied ✓' : 'Copy' }}</button>
        </div>
      </div>

      <button class="primary" @click="goToChats">Go to my chats</button>
    </template>
  </div>
</template>

<style scoped>
.create-account {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 0;
}

.back-link {
  align-self: flex-start;
  padding: 0.2rem 0;
  background: none;
  border: none;
  color: var(--accent-blue);
  font-size: 0.85rem;
  font-weight: 600;
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
