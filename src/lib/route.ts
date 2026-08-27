// A three-screen app doesn't need a router — just enough hash parsing to
// tell the three screens apart and to carry a session id (and, on a
// personal link, a private key) in the URL.
import { ref } from 'vue'
import type { Role } from '../api/session'

export type Route =
  | { name: 'home' }
  | { name: 'join'; sessionId: string }
  | { name: 'chat'; sessionId: string; role: Role; packedKey: string }
  | { name: 'account'; accountId: string; packedKey: string }

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)

  if (parts[0] === 'join' && parts[1]) {
    return { name: 'join', sessionId: parts[1] }
  }
  if (parts[0] === 'chat' && parts[1] && parts[2] && parts[3]) {
    const role: Role = parts[2] === 'joiner' ? 'joiner' : 'starter'
    return { name: 'chat', sessionId: parts[1], role, packedKey: parts[3] }
  }
  if (parts[0] === 'account' && parts[1] && parts[2]) {
    return { name: 'account', accountId: parts[1], packedKey: parts[2] }
  }
  return { name: 'home' }
}

/**
 * Pulls just the `#/chat/...` or `#/join/...` fragment out of whatever was
 * pasted — a full link (any origin, e.g. a different Netlify preview), a
 * bare fragment, or a fragment missing its leading `#`. All deploys share
 * the same Supabase backend, so only the fragment matters.
 */
export function extractHash(pasted: string): string {
  const trimmed = pasted.trim()
  const hashIndex = trimmed.indexOf('#')
  if (hashIndex !== -1) return trimmed.slice(hashIndex)
  return trimmed.startsWith('/') ? `#${trimmed}` : `#/${trimmed}`
}

export const route = ref<Route>(parseHash(window.location.hash))

window.addEventListener('hashchange', () => {
  route.value = parseHash(window.location.hash)
})

export function navigate(hash: string) {
  window.location.hash = hash
}

/**
 * Like `navigate`, but doesn't add a history entry — used right after
 * consuming an account link, so the private key it carried doesn't linger
 * in back-history once it's saved to this device.
 */
export function navigateReplace(hash: string) {
  history.replaceState(null, '', hash)
  route.value = parseHash(hash)
}

export function chatHash(sessionId: string, role: Role, packedKey: string): string {
  return `#/chat/${sessionId}/${role}/${packedKey}`
}

export function inviteHash(sessionId: string): string {
  return `#/join/${sessionId}`
}

export function accountHash(accountId: string, packedKey: string): string {
  return `#/account/${accountId}/${packedKey}`
}

export const homeHash = '#/'
