<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { currentAccount, logout } from '../lib/auth'
import { startNewSession, adoptGuestIdentity } from '../api/sessionActions'
import { fetchSessionList, type SessionListItem } from '../api/sessionList'
import { checkForInvites, acceptInvite, rejectInvite, type PendingInvite } from '../api/inviteActions'
import { exportPublicKey, packJwk } from '../lib/crypto'
import { copyToClipboard } from '../lib/clipboard'
import { mySessionHash, navigate, homeHash, parseHash, extractHash } from '../lib/route'
import { logDebug } from '../debug'
import Modal from './Modal.vue'

const items = ref<SessionListItem[]>([])
const loading = ref(true)
const starting = ref(false)
const failed = ref(false)
const pastedLink = ref('')
const pasteError = ref('')

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

// Share-my-key + pending invites: see api/inviteActions.ts and
// lib/crypto.ts's "Pairwise discoverable secrets" section. My public key
// is safe to show/copy openly (it's already the one intentionally public
// value in this schema) — someone else pastes it into their own session's
// "Invite by key" to add me, entirely out of band, no lookup involved.
const myPublicKeyBlob = ref('')
const pendingInvites = ref<PendingInvite[]>([])
const invitesLoading = ref(true)
const respondingId = ref<string | null>(null)

onMounted(async () => {
  if (!currentAccount.value) return
  myPublicKeyBlob.value = packJwk(await exportPublicKey(currentAccount.value.publicKey))
  invitesLoading.value = true
  try {
    pendingInvites.value = await checkForInvites(currentAccount.value)
  } catch (err) {
    logDebug(`checkForInvites failed: ${err}`, 'error')
  } finally {
    invitesLoading.value = false
  }
})

// Account menu: a small popover with "My public key" and "Adopt guest
// account" — both open in a modal rather than an inline panel.
const showAccountMenu = ref(false)
const showMyKeyModal = ref(false)
const showAdoptModal = ref(false)
const copiedMyKey = ref(false)

function toggleAccountMenu() {
  showAccountMenu.value = !showAccountMenu.value
}

function openMyKeyModal() {
  showAccountMenu.value = false
  showMyKeyModal.value = true
}

function openAdoptModal() {
  showAccountMenu.value = false
  adoptError.value = ''
  showAdoptModal.value = true
}

async function copyMyKey() {
  if (await copyToClipboard(myPublicKeyBlob.value)) {
    copiedMyKey.value = true
    setTimeout(() => (copiedMyKey.value = false), 1500)
  }
}

// Adopt a guest account: paste any guest identity's private key from
// anywhere, and adoptGuestIdentity figures out which session it belongs to
// itself — no need to already be viewing that session. See
// api/sessionActions.ts's adoptGuestIdentity doc comment.
const adoptInput = ref('')
const adopting = ref(false)
const adoptError = ref('')

async function adoptGuestAccount() {
  if (!currentAccount.value) return
  const pasted = adoptInput.value.trim()
  if (!pasted) return

  adopting.value = true
  adoptError.value = ''
  try {
    const ok = await adoptGuestIdentity(pasted, currentAccount.value)
    if (!ok) {
      adoptError.value = "Could not adopt that account — check it's a valid guest personal link or key."
      return
    }
    showAdoptModal.value = false
    adoptInput.value = ''
    await loadList() // the adopted session may be new to this account's list
  } catch (err) {
    logDebug(`adoptGuestAccount failed: ${err}`, 'error')
    adoptError.value = "That doesn't look like a private key or personal link — check you copied the whole thing."
  } finally {
    adopting.value = false
  }
}

async function respondToInvite(invite: PendingInvite, accept: boolean) {
  if (!currentAccount.value) return
  respondingId.value = invite.id
  try {
    if (accept) {
      const started = await acceptInvite(invite, currentAccount.value)
      if (!started) return
      pendingInvites.value = pendingInvites.value.filter((i) => i.id !== invite.id)
      navigate(mySessionHash(started.sessionId))
    } else {
      await rejectInvite(invite.id)
      pendingInvites.value = pendingInvites.value.filter((i) => i.id !== invite.id)
    }
  } finally {
    respondingId.value = null
  }
}

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

function nameFor(item: SessionListItem): string {
  if (!item.otherParticipants.length) return item.title || 'Just you, for now'
  return item.title || item.otherParticipants.join(', ')
}

function onLogout() {
  logout()
  navigate(homeHash)
}

const accountMenuArea = ref<HTMLElement>()
function onDocClick(e: MouseEvent) {
  if (accountMenuArea.value && !accountMenuArea.value.contains(e.target as Node)) {
    showAccountMenu.value = false
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="account-home">
    <div class="top-row">
      <p class="whoami">Signed in as <strong>{{ currentAccount?.account.username }}</strong></p>
      <div ref="accountMenuArea" class="top-row-actions">
        <div class="menu-wrap">
          <button class="chip-ghost tone-blue" @click.stop="toggleAccountMenu">Account ▾</button>
          <div v-if="showAccountMenu" class="menu-pop">
            <button class="menu-item" @click="openMyKeyModal">My public key</button>
            <button class="menu-item" @click="openAdoptModal">Adopt guest account</button>
          </div>
        </div>
        <button class="chip-ghost tone-danger" @click="onLogout">Log out</button>
      </div>
    </div>

    <Modal :open="showMyKeyModal" title="My public key" @close="showMyKeyModal = false">
      <p class="hint">
        Share this with someone (in person, or however you already trust) so they can invite you to
        a session directly, without a link.
      </p>
      <div class="link-row">
        <input readonly :value="myPublicKeyBlob" @focus="($event.target as HTMLInputElement).select()" />
        <button @click="copyMyKey">{{ copiedMyKey ? 'Copied ✓' : 'Copy' }}</button>
      </div>
    </Modal>

    <Modal :open="showAdoptModal" title="Adopt guest account" @close="showAdoptModal = false">
      <p class="hint">
        Paste a guest identity's private key (e.g. from that link's ⚠ Warning button) to recognize
        it as you — its messages will render as yours wherever it appears, without touching that
        link or anyone else's view of it. Works for any session it's part of; you don't need to open
        that session first.
      </p>
      <input
        v-model="adoptInput"
        placeholder="Paste their private key or personal link"
        @keydown.enter="adoptGuestAccount"
      />
      <button class="primary" :disabled="adopting || !adoptInput.trim()" @click="adoptGuestAccount">
        {{ adopting ? 'Adopting…' : 'Adopt account' }}
      </button>
      <p v-if="adoptError" class="error">{{ adoptError }}</p>
    </Modal>

    <ul v-if="pendingInvites.length" class="list invites">
      <li v-for="invite in pendingInvites" :key="invite.id" class="row invite-row">
        <span class="name">New session invite</span>
        <div class="invite-actions">
          <button
            class="chip"
            :disabled="respondingId === invite.id"
            @click="respondToInvite(invite, true)"
          >
            Accept
          </button>
          <button
            class="chip warning"
            :disabled="respondingId === invite.id"
            @click="respondToInvite(invite, false)"
          >
            Reject
          </button>
        </div>
      </li>
    </ul>

    <button class="primary" :disabled="starting" @click="startSession">
      {{ starting ? 'Starting…' : 'Start a session' }}
    </button>
    <p v-if="failed" class="error">Couldn't start a session — check your connection and try again.</p>

    <div class="divider"><span>or</span></div>

    <div class="link-block">
      <label>Join a session</label>
      <p class="hint">Paste an invite link, and it'll be added to your chat list.</p>
      <div class="link-row">
        <input v-model="pastedLink" placeholder="Paste link here" @keydown.enter="goToPastedLink" />
        <button @click="goToPastedLink">Go</button>
      </div>
      <p v-if="pasteError" class="error">{{ pasteError }}</p>
    </div>

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

.top-row-actions {
  display: flex;
  gap: 0.4rem;
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

.chip.warning {
  border-color: var(--danger);
  color: var(--danger);
}

.chip:disabled {
  opacity: 0.6;
}

.chip-ghost {
  padding: 0.35rem 0.7rem;
  min-height: 40px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
}

.chip-ghost.tone-blue {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.chip-ghost.tone-danger {
  border-color: var(--danger);
  color: var(--danger);
}

.menu-wrap {
  position: relative;
}

.menu-pop {
  position: absolute;
  top: calc(100% + 0.3rem);
  right: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  min-width: 10rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}

.menu-item {
  padding: 0.7rem 0.9rem;
  min-height: 44px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  font-size: 0.85rem;
}

.menu-item:hover {
  background: var(--bg-elev-2);
}

.modal-body input,
.modal-body .link-row input {
  padding: 0.6rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg);
  color: var(--text);
  font-size: 0.9rem;
}

.invite-row {
  cursor: default;
}

.invite-actions {
  display: flex;
  gap: 0.4rem;
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
