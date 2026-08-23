// A three-screen app doesn't need a router — just enough hash parsing to
// tell the three screens apart and to carry a session id (and, on a
// personal link, a private key) in the URL.
import { ref } from 'vue'
import type { Role } from '../api/session'

export type Route =
  | { name: 'home' }
  | { name: 'join'; sessionId: string }
  | { name: 'chat'; sessionId: string; role: Role; packedKey: string }

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)

  if (parts[0] === 'join' && parts[1]) {
    return { name: 'join', sessionId: parts[1] }
  }
  if (parts[0] === 'chat' && parts[1] && parts[2] && parts[3]) {
    const role: Role = parts[2] === 'joiner' ? 'joiner' : 'starter'
    return { name: 'chat', sessionId: parts[1], role, packedKey: parts[3] }
  }
  return { name: 'home' }
}

export const route = ref<Route>(parseHash(window.location.hash))

window.addEventListener('hashchange', () => {
  route.value = parseHash(window.location.hash)
})

export function navigate(hash: string) {
  window.location.hash = hash
}

export function chatHash(sessionId: string, role: Role, packedKey: string): string {
  return `#/chat/${sessionId}/${role}/${packedKey}`
}

export function inviteHash(sessionId: string): string {
  return `#/join/${sessionId}`
}

export const homeHash = '#/'
