<script setup lang="ts">
import { ref } from 'vue'
import { startNewSession } from '../api/sessionActions'
import { sessionHash, navigate, parseHash, extractHash } from '../lib/route'
import { logDebug } from '../debug'
import CreateAccount from './CreateAccount.vue'

const starting = ref(false)
const failed = ref(false)
const pastedLink = ref('')
const pasteError = ref('')
const showCreateAccount = ref(false)

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
    <button class="primary" :disabled="starting" @click="startSession">
      {{ starting ? 'Starting…' : 'Start a session' }}
    </button>
    <p v-if="failed" class="error">Couldn't start a session — check your connection and try again.</p>

    <div class="divider"><span>or</span></div>

    <div class="link-block">
      <label>Go to a session</label>
      <p class="hint">Paste a personal or invite link you saved, and it'll take you there.</p>
      <div class="link-row">
        <input v-model="pastedLink" placeholder="Paste link here" @keydown.enter="goToPastedLink" />
        <button @click="goToPastedLink">Go</button>
      </div>
      <p v-if="pasteError" class="error">{{ pasteError }}</p>
    </div>

    <div class="divider"><span>or</span></div>

    <button v-if="!showCreateAccount" class="secondary" @click="showCreateAccount = true">
      Create an account
    </button>
    <CreateAccount v-else @cancel="showCreateAccount = false" />
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
