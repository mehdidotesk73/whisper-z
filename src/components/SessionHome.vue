<script setup lang="ts">
import { ref } from 'vue'
import { startNewSession } from '../api/sessionActions'
import { sessionHash, navigate, parseHash, extractHash, extractAccountKey } from '../lib/route'
import { loginWithPackedKey } from '../lib/auth'
import { logDebug } from '../debug'
import CreateAccount from './CreateAccount.vue'

const starting = ref(false)
const failed = ref(false)
const pastedLink = ref('')
const pasteError = ref('')
const showCreateAccount = ref(false)
const showLogin = ref(false)
const loginInput = ref('')
const loginError = ref('')
const loggingIn = ref(false)

async function login() {
  loginError.value = ''
  const pasted = loginInput.value.trim()
  if (!pasted) return

  loggingIn.value = true
  try {
    const key = extractAccountKey(pasted)
    const ok = await loginWithPackedKey(key)
    if (!ok) {
      loginError.value = "That didn't work — check you pasted the whole link or key."
      return
    }
    // currentAccount is reactive, so App.vue swaps straight to AccountHome —
    // nothing else to do here.
  } catch (err) {
    logDebug(`login failed: ${err}`, 'error')
    loginError.value = "That didn't work — check you pasted the whole link or key."
  } finally {
    loggingIn.value = false
  }
}

async function startSession() {
  starting.value = true
  failed.value = false
  try {
    const started = await startNewSession(null)
    if (!started || !started.packedKey) {
      failed.value = true
      return
    }
    navigate(sessionHash(started.packedKey))
  } catch (err) {
    logDebug(`startSession failed: ${err}`, 'error')
    failed.value = true
  } finally {
    starting.value = false
  }
}

function goToPastedLink() {
  pasteError.value = ''
  if (!pastedLink.value.trim()) return

  const hash = extractHash(pastedLink.value)
  if (parseHash(hash).name === 'home') {
    pasteError.value = "That doesn't look like a session link — check you copied the whole thing."
    return
  }
  navigate(hash)
}
</script>

<template>
  <div class="home">
    <p class="intro">
      Start an end-to-end encrypted session. Your keys are generated in this browser and never sent
      anywhere — only you (and whoever you invite) can read the messages.
    </p>
    <div v-if="!showCreateAccount && !showLogin" class="account-actions">
      <button class="secondary" @click="showCreateAccount = true">Create an account</button>
      <button class="secondary" @click="showLogin = true">Log in</button>
    </div>
    <CreateAccount v-else-if="showCreateAccount" @cancel="showCreateAccount = false" />
    <div v-else class="link-block">
      <label>Log in with your account</label>
      <p class="hint">Paste your account link (preview or production) or just the key itself.</p>
      <div class="link-row">
        <input v-model="loginInput" placeholder="Paste your account link or key" @keydown.enter="login" />
        <button :disabled="loggingIn || !loginInput.trim()" @click="login">
          {{ loggingIn ? 'Logging in…' : 'Log in' }}
        </button>
      </div>
      <button class="secondary" @click="showLogin = false">Cancel</button>
      <p v-if="loginError" class="error">{{ loginError }}</p>
    </div>

    <template v-if="!showCreateAccount && !showLogin">
      <div class="divider"><span>or</span></div>

      <button class="primary" :disabled="starting" @click="startSession">
        {{ starting ? 'Starting…' : 'Start a session' }}
      </button>
      <p v-if="failed" class="error">Couldn't start a session — check your connection and try again.</p>

      <div class="divider"><span>or</span></div>

      <div class="link-block">
        <label>Join a session</label>
        <p class="hint">Paste a personal or invite link you saved, and it'll take you there.</p>
        <div class="link-row">
          <input v-model="pastedLink" placeholder="Paste link here" @keydown.enter="goToPastedLink" />
          <button @click="goToPastedLink">Go</button>
        </div>
        <p v-if="pasteError" class="error">{{ pasteError }}</p>
      </div>
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

.account-actions {
  display: flex;
  gap: 0.5rem;
}

.account-actions .secondary {
  flex: 1;
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

.secondary {
  padding: 0.75rem 1rem;
  min-height: 44px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  color: var(--text);
  font-weight: 600;
}
</style>
