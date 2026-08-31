// Every E2E test creates real rows in the live Supabase project (see
// playwright.config.ts). The `manifest` fixture is how a test hands back
// what it created so this file can clean it up afterward — the test itself
// only ever needs to call `manifest.track(packedPrivateKey)` once per
// identity it brings into existence (an account, a guest, an admin — same
// call either way).
//
// Cleanup doesn't need a table-by-table log of every insert: `session-access`
// is looked up by a tag derived from the identity's own private key, and the
// row it finds decrypts to the sessionId it belongs to. So a single packed
// private key is enough to walk back to everything that identity is
// connected to and delete it — see cleanupIdentity below.
import { test as base } from '@playwright/test'
import { importPrivateKey, unpackJwk, deriveLookupTag, openSealed } from '../src/lib/crypto'
import { supabase } from '../src/api/supabase'
import { toEnvelope } from '../src/api/sessions'

export interface TestManifest {
  /** Register a packed private key (from a personal/account link) for cleanup once the test ends. */
  track(packedPrivateKey: string): void
}

async function cleanupIdentity(packedPrivateKey: string): Promise<void> {
  const privateKey = await importPrivateKey(unpackJwk(packedPrivateKey))
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
}

export const test = base.extend<{ manifest: TestManifest }>({
  manifest: async ({}, use) => {
    const tracked = new Set<string>()
    await use({ track: (key) => tracked.add(key) })

    for (const key of tracked) {
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

export { expect } from '@playwright/test'
