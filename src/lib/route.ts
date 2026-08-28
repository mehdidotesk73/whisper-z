// Three link shapes, no vue-router needed:
//  - a personal link carries only a private key; everything else (which
//    session, the session key, your role) is recovered by deriving your
//    lookup tag from that key and decrypting your own session_access row
//  - a join link carries a lookup id (safe, not secret) and a symmetric
//    secret used directly as a raw AES key
//  - an account link (once accounts exist) works the same way as a
//    personal link, just for account identity instead of a session
import { ref } from 'vue'

export type Route =
  | { name: 'home' }
  | { name: 'join'; joinId: string; secret: string }
  | { name: 'session'; packedKey: string }

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)

  if (parts[0] === 'join' && parts[1] && parts[2]) {
    return { name: 'join', joinId: parts[1], secret: parts[2] }
  }
  if (parts[0] === 'session' && parts[1]) {
    return { name: 'session', packedKey: parts[1] }
  }
  return { name: 'home' }
}

/**
 * Pulls just the `#/session/...` or `#/join/...` fragment out of whatever
 * was pasted — a full link (any origin, e.g. a different Netlify preview),
 * a bare fragment, or a fragment missing its leading `#`. All deploys share
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

/** Like `navigate`, but doesn't add a history entry — used right after consuming a one-time link. */
export function navigateReplace(hash: string) {
  history.replaceState(null, '', hash)
  route.value = parseHash(hash)
}

export function sessionHash(packedKey: string): string {
  return `#/session/${packedKey}`
}

export function joinHash(joinId: string, secret: string): string {
  return `#/join/${joinId}/${secret}`
}

export const homeHash = '#/'
