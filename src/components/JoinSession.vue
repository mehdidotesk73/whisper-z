<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { importJoinKey, decryptText, urlSafeToBytes } from '../lib/crypto'
import { fetchJoinAccess, claimJoinAccess, isJoinAccessExpired } from '../api/sessions'
import { joinExistingSession } from '../api/sessionActions'
import { currentAccount, loginWithPackedKey } from '../lib/auth'
import { sessionHash, mySessionHash, navigate, parseHash, extractHash } from '../lib/route'
import type { JoinPayload } from '../lib/sessionTypes'
import { logDebug } from '../debug'

const props = defineProps<{ joinId: string; secret: string }>()

type Status = 'loading' | 'ready' | 'invalid' | 'joining' | 'failed'
const status = ref<Status>('loading')
const invalidReason = ref("This invite link doesn't work — check you copied the whole thing.")

// Only shown when not already logged in: lets someone with an account log
// in on the spot (pasting their account link) instead of joining as a
// throwaway guest, then joins as that account.
const showExistingLogin = ref(false)
const accountLinkInput = ref('')
const loginError = ref('')

async function joinAsExistingUser() {
  loginError.value = ''
  const pasted = accountLinkInput.value.trim()
  if (!pasted) return

  const parsed = parseHash(extractHash(pasted))
  if (parsed.name !== 'account') {
    loginError.value = "That doesn't look like an account link — check you copied the whole thing."
    return
  }

  const ok = await loginWithPackedKey(parsed.packedKey)
  if (!ok) {
    loginError.value = "That account link didn't work — check you copied the whole thing."
    return
  }

  showExistingLogin.value = false
  await join()
}

onMounted(async () => {
  try {
    const row = await fetchJoinAccess(props.joinId)
    if (!row) {
      status.value = 'invalid'
      return
    }
    if (row.consumed_at) {
      invalidReason.value = 'This invite link has already been used.'
      status.value = 'invalid'
      return
    }
    if (isJoinAccessExpired(row)) {
      invalidReason.value = 'This invite link has expired — ask for a new one.'
      status.value = 'invalid'
      return
    }

    // Decrypted only to confirm the secret actually matches this row (a
    // mistyped link fails here); the real, single-use redemption happens in
    // join() below via an atomic claim, not this read-only lookup.
    const joinKey = await importJoinKey(urlSafeToBytes(props.secret))
    await decryptText(joinKey, { ciphertext: row.ciphertext, iv: row.iv })
    status.value = 'ready'
  } catch (err) {
    logDebug(`Could not open invite link: ${err}`, 'warn')
    status.value = 'invalid'
  }
})

async function join() {
  status.value = 'joining'

  try {
    // Atomic: of any number of people clicking "Join" on this same link at
    // once, exactly one gets a non-null row back — see claimJoinAccess.
    const claimed = await claimJoinAccess(props.joinId)
    if (!claimed || isJoinAccessExpired(claimed)) {
      invalidReason.value = claimed
        ? 'This invite link has expired — ask for a new one.'
        : 'This invite link has already been used.'
      status.value = 'invalid'
      return
    }

    const joinKey = await importJoinKey(urlSafeToBytes(props.secret))
    const json = await decryptText(joinKey, { ciphertext: claimed.ciphertext, iv: claimed.iv })
    const joinPayload = JSON.parse(json) as JoinPayload

    const started = await joinExistingSession(joinPayload, currentAccount.value, 'link')
    if (!started) {
      status.value = 'failed'
      return
    }
    navigate(started.packedKey ? sessionHash(started.packedKey) : mySessionHash(started.sessionId))
  } catch (err) {
    logDebug(`join failed: ${err}`, 'error')
    status.value = 'failed'
  }
}
</script>

<template>
  <div class="join">
    <p v-if="status === 'loading'" class="status">Loading…</p>

    <p v-else-if="status === 'invalid'" class="status error">{{ invalidReason }}</p>

    <template v-else-if="currentAccount">
      <p class="intro">You've been invited to an encrypted session.</p>
      <button class="primary" :disabled="status === 'joining'" @click="join">
        {{ status === 'joining' ? 'Joining…' : `Join as ${currentAccount.account.username}` }}
      </button>
      <p v-if="status === 'failed'" class="error">Couldn't join — check your connection and try again.</p>
    </template>

    <template v-else-if="!showExistingLogin">
      <p class="intro">
        You've been invited to an encrypted session. Joining as a guest generates a keypair in this
        browser — your private key never leaves it.
      </p>
      <button class="primary" :disabled="status === 'joining'" @click="join">
        {{ status === 'joining' ? 'Joining…' : 'Join as guest' }}
      </button>
      <button class="secondary" @click="showExistingLogin = true">Join as existing user</button>
      <p v-if="status === 'failed'" class="error">Couldn't join — check your connection and try again.</p>
    </template>

    <template v-else>
      <p class="intro">Paste your account link to sign in and join with that account.</p>
      <input
        v-model="accountLinkInput"
        placeholder="Paste your account link"
        @keydown.enter="joinAsExistingUser"
      />
      <p v-if="loginError" class="error">{{ loginError }}</p>
      <div class="row">
        <button class="primary" :disabled="status === 'joining' || !accountLinkInput.trim()" @click="joinAsExistingUser">
          {{ status === 'joining' ? 'Joining…' : 'Log in & join' }}
        </button>
        <button class="secondary" @click="showExistingLogin = false; loginError = ''">Cancel</button>
      </div>
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

.status {
  color: var(--text-muted);
  text-align: center;
}

.status.error {
  color: var(--danger);
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

.secondary {
  padding: 0.75rem 1rem;
  min-height: 44px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  color: var(--text);
  font-weight: 600;
}

.row {
  display: flex;
  gap: 0.5rem;
}

.row .primary,
.row .secondary {
  flex: 1;
}

input {
  padding: 0.6rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg);
  color: var(--text);
  font-size: 0.9rem;
}

.error {
  color: var(--danger);
  margin: 0;
}
</style>
