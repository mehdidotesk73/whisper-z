<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { currentAccount, logout } from '../lib/auth'
import { startNewSession } from '../api/sessionActions'
import { fetchSessionList, type SessionListItem } from '../api/sessionList'
import { mySessionHash, navigate, homeHash } from '../lib/route'
import { logDebug } from '../debug'

const items = ref<SessionListItem[]>([])
const loading = ref(true)
const starting = ref(false)
const failed = ref(false)

async function loadList() {
  if (!currentAccount.value) return
  loading.value = true
  try {
    items.value = await fetchSessionList(currentAccount.value)
  } catch (err) {
    logDebug(`fetchSessionList failed: ${err}`, 'error')
  } finally {
    loading.value = false
  }
}

onMounted(loadList)

async function startSession() {
  if (!currentAccount.value) return
  starting.value = true
  failed.value = false
  try {
    const started = await startNewSession(currentAccount.value)
    if (!started) {
      failed.value = true
      return
    }
    navigate(mySessionHash(started.sessionId))
  } catch (err) {
    logDebug(`startSession failed: ${err}`, 'error')
    failed.value = true
  } finally {
    starting.value = false
  }
}

function openSession(sessionId: string) {
  navigate(mySessionHash(sessionId))
}

function nameFor(item: SessionListItem): string {
  if (!item.otherParticipants.length) return item.title || 'Just you, for now'
  return item.title || item.otherParticipants.join(', ')
}

function onLogout() {
  logout()
  navigate(homeHash)
}
</script>

<template>
  <div class="account-home">
    <div class="top-row">
      <p class="whoami">Signed in as <strong>{{ currentAccount?.account.username }}</strong></p>
      <button class="chip" @click="onLogout">Log out</button>
    </div>

    <button class="primary" :disabled="starting" @click="startSession">
      {{ starting ? 'Starting…' : 'Start a session' }}
    </button>
    <p v-if="failed" class="error">Couldn't start a session — check your connection and try again.</p>

    <p v-if="loading" class="status">Loading your sessions…</p>
    <ul v-else class="list">
      <li v-if="!items.length" class="empty">No sessions yet — start one above, or open an invite link.</li>
      <li v-for="item in items" :key="item.sessionId" class="row" @click="openSession(item.sessionId)">
        <span class="name">{{ nameFor(item) }}</span>
        <span class="role">{{ item.role }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.account-home {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 0;
}

.top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.whoami {
  margin: 0;
  color: var(--text-muted);
}

.chip {
  padding: 0.4rem 0.8rem;
  min-height: 44px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 600;
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

.status {
  color: var(--text-muted);
  margin: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.empty {
  color: var(--text-muted);
  padding: 0.75rem;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.75rem;
  min-height: 44px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  cursor: pointer;
}

.row:hover {
  border-color: var(--accent-blue);
}

.name {
  font-weight: 600;
}

.role {
  color: var(--text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
}
</style>
