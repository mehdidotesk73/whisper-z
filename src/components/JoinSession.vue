<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { importJoinKey, decryptText, urlSafeToBytes } from '../lib/crypto'
import { fetchJoinAccess, claimJoinAccess, isJoinAccessExpired } from '../api/sessions'
import { joinExistingSession } from '../api/sessionActions'
import { currentAccount } from '../lib/auth'
import { sessionHash, mySessionHash, navigate } from '../lib/route'
import type { JoinPayload } from '../lib/sessionTypes'
import { logDebug } from '../debug'

const props = defineProps<{ joinId: string; secret: string }>()

type Status = 'loading' | 'ready' | 'invalid' | 'joining' | 'failed'
const status = ref<Status>('loading')
const invalidReason = ref("This invite link doesn't work — check you copied the whole thing.")

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

    const started = await joinExistingSession(joinPayload, currentAccount.value)
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

    <template v-else>
      <p class="intro">
        You've been invited to an encrypted session.
        <template v-if="currentAccount">This will add it to {{ currentAccount.account.username }}'s chat list.</template>
        <template v-else>Joining generates your own keypair in this browser — your private key never leaves it.</template>
      </p>
      <button class="primary" :disabled="status === 'joining'" @click="join">
        {{ status === 'joining' ? 'Joining…' : 'Join session' }}
      </button>
      <p v-if="status === 'failed'" class="error">Couldn't join — check your connection and try again.</p>
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

.error {
  color: var(--danger);
  margin: 0;
}
</style>
