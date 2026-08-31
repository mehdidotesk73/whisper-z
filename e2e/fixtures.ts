// Every E2E test creates real rows in the live Supabase project (see
// playwright.config.ts). The `manifest` fixture is how a test hands back
// what it created so this file can clean it up afterward — the test itself
// only ever needs to call `manifest.track(packedPrivateKey)` once per
// identity it brings into existence (an account, a guest, an admin — same
// call either way), plus `trackJoinAccess`/`trackInvite` for the two things
// an identity's own key can't walk back to on its own (see below).
import { test as base } from '@playwright/test'
import {
  importPrivateKey,
  unpackJwk,
  deriveLookupTag,
  openSealed,
  publicJwkFromPrivateJwk,
  canonicalPublicKeyId,
  importPublicKey,
  derivePairwiseSecret,
  derivePairwiseTag,
} from '../src/lib/crypto'
import { supabase } from '../src/api/supabase'
import { toEnvelope } from '../src/api/sessions'

/**
 * A deliberately local re-implementation of route.ts's extractPackedKey,
 * not an import of it: route.ts reads `window.location.hash` at module load
 * time, which is fine inside a browser page but crashes here — this file is
 * imported by Playwright's own Node-side test-collection process (no DOM at
 * all) before any browser is even launched. Handles exactly the two shapes
 * this file's callers pass in: a bare packed key, or a full `#/session/<key>`
 * or `#/account/<key>` link (any origin).
 */
function extractPackedKey(pastedOrKey: string): string {
  const trimmed = pastedOrKey.trim()
  const hashIndex = trimmed.indexOf('#')
  const hash = hashIndex !== -1 ? trimmed.slice(hashIndex) : trimmed.startsWith('/') ? `#${trimmed}` : `#/${trimmed}`
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if ((parts[0] === 'session' || parts[0] === 'account') && parts[1]) return parts[1]
  return trimmed
}

export interface TestManifest {
  /**
   * Register an identity for cleanup once the test ends — a bare packed
   * private key, or a full personal/account link (anything
   * `extractPackedKey` already knows how to read).
   */
  track(packedKeyOrLink: string): void
  /** Register a join link's joinId (the `#/join/<joinId>/<secret>` segment) for cleanup. */
  trackJoinAccess(joinId: string): void
  /** Register a public-key invite for cleanup — pass both sides' packed private keys, in either order. */
  trackInvite(packedPrivateKeyA: string, packedPrivateKeyB: string): void
}

async function cleanupIdentity(packedKeyOrLink: string): Promise<void> {
  const jwk = unpackJwk(extractPackedKey(packedKeyOrLink))
  const privateKey = await importPrivateKey(jwk)
  const ownerTag = await deriveLookupTag(privateKey, 'session-access')

  const { data: rows } = await supabase.from('session_access').select('*').eq('owner_tag', ownerTag)
  const accessRowIds: string[] = []
  const sessionIds: string[] = []

  for (const row of rows ?? []) {
    accessRowIds.push(row.id)
    try {
      const payload = await openSealed<{ sessionId: string }>(toEnvelope(row), privateKey)
      sessionIds.push(payload.sessionId)
    } catch {
      // Sealed to a different identity than expected — not ours, leave it alone.
    }
  }

  // `sessions` cascades to `session_log` and `session_participants` (both
  // ON DELETE CASCADE). `session_access` has no FK to sessions at all, so it
  // needs its own explicit delete — see the FK-cascade check in
  // docs/system-design.md before assuming any other table cascades too.
  if (sessionIds.length) await supabase.from('sessions').delete().in('id', sessionIds)
  if (accessRowIds.length) await supabase.from('session_access').delete().in('id', accessRowIds)

  // A guest identity never has an `accounts` row, so this is a harmless
  // no-op delete for every guest key tracked — cheaper than tracking
  // separately which identities are accounts.
  const publicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(jwk))
  await supabase.from('accounts').delete().eq('public_key', publicKeyId)
}

async function cleanupJoinAccess(joinId: string): Promise<void> {
  await supabase.from('join_access').delete().eq('id', joinId)
}

async function cleanupInvite(packedPrivateKeyA: string, packedPrivateKeyB: string): Promise<void> {
  // session_invites is looked up by a tag derived from a pairwise ECDH
  // secret (src/api/inviteActions.ts) — computable from either side's
  // private key plus the other's public key, same as the app itself does.
  const privateKeyA = await importPrivateKey(unpackJwk(extractPackedKey(packedPrivateKeyA)))
  const jwkB = unpackJwk(extractPackedKey(packedPrivateKeyB))
  const publicKeyB = await importPublicKey(publicJwkFromPrivateJwk(jwkB))
  const secret = await derivePairwiseSecret(privateKeyA, publicKeyB)
  const tag = await derivePairwiseTag(secret, 'session-invite-tag')
  await supabase.from('session_invites').delete().eq('tag', tag)
}

export const test = base.extend<{ manifest: TestManifest }>({
  manifest: async ({}, use) => {
    const trackedKeys = new Set<string>()
    const trackedJoinIds = new Set<string>()
    const trackedInvitePairs: [string, string][] = []

    await use({
      track: (key) => trackedKeys.add(key),
      trackJoinAccess: (joinId) => trackedJoinIds.add(joinId),
      trackInvite: (a, b) => trackedInvitePairs.push([a, b]),
    })

    // Order matters a little: invites and join links first (independent of
    // anything else), then identities last (which is what tears down the
    // sessions those links/invites pointed at).
    for (const [a, b] of trackedInvitePairs) {
      try {
        await cleanupInvite(a, b)
      } catch (err) {
        console.warn(`e2e cleanup failed for one tracked invite: ${err}`)
      }
    }
    for (const joinId of trackedJoinIds) {
      try {
        await cleanupJoinAccess(joinId)
      } catch (err) {
        console.warn(`e2e cleanup failed for one tracked join link: ${err}`)
      }
    }
    for (const key of trackedKeys) {
      try {
        await cleanupIdentity(key)
      } catch (err) {
        // Best-effort: one identity failing to clean up shouldn't hide the
        // others, and shouldn't fail a test that already passed or failed on
        // its own merits. Falls to the manual backstop sweep described in
        // docs/system-design.md.
        console.warn(`e2e cleanup failed for one tracked identity: ${err}`)
      }
    }
  },
})

// A generic safety net: whenever a test fails, capture whatever the app's
// own on-screen debug log (src/debug.ts) had recorded on the default page —
// real exception detail (name, message, stack frames), not just static UI
// text a catch block chose to show. This is what turned second-account-via-
// invite's silent, uninformative timeout into an actual diagnosis. Scoped to
// the default `page` fixture only — a scenario using extra browser contexts
// (most of them do) won't get this for pages it created itself; the specific
// helper that needs it (sendInviteByKey) reads the log inline instead.
// Attachments land in the test's results directory, which ci.yml uploads as
// an artifact on failure.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return
  try {
    const isOpen = await page.locator('.log-window').isVisible()
    if (!isOpen) await page.getByRole('button', { name: 'View logs' }).click({ timeout: 2000 })
    const logText = await page.locator('.debug-log').innerText({ timeout: 2000 })
    await testInfo.attach('app-debug-log', { body: logText, contentType: 'text/plain' })
  } catch (err) {
    await testInfo.attach('app-debug-log-capture-failed', { body: String(err), contentType: 'text/plain' })
  }
})

export { expect } from '@playwright/test'
