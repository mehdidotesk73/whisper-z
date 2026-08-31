import { test, expect } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getMyPublicKey,
  sendInviteByKey,
  uniqueUsername,
  NETWORK_TIMEOUT,
} from './helpers'

// Covers: sending a public-key invite must not itself grant access — only
// acceptInvite (SessionView.vue's respondToInvite → acceptInvite) does.
// Confirms the invitee sees the invite as pending (Accept/Reject visible)
// but has no session in its chat list until it actually accepts.
test('an invite that is never accepted does not grant access on its own', async ({ page, browser, manifest }) => {
  await page.goto('/')

  const account1Link = await createAccount(page, uniqueUsername('acct1'))
  manifest.track(account1Link)
  await startSessionAsAccount(page)

  const account2Context = await browser.newContext()
  const account2Page = await account2Context.newPage()
  try {
    await account2Page.goto('/')
    const account2Link = await createAccount(account2Page, uniqueUsername('acct2'))
    manifest.track(account2Link)
    const account2PublicKey = await getMyPublicKey(account2Page)

    await sendInviteByKey(page, account2PublicKey)
    manifest.trackInvite(account1Link, account2Link)

    // The invite itself is a positive, waitable signal — confirming it's
    // visible before checking the session list means the mount-time fetch
    // that would also load any (here, nonexistent) session access has
    // already had at least as long to run.
    await account2Page.reload()
    await expect(account2Page.getByRole('button', { name: 'Accept' })).toBeVisible({ timeout: NETWORK_TIMEOUT })
    await expect(account2Page.locator('.list .row:not(.invite-row)')).toHaveCount(0)
  } finally {
    await account2Context.close()
  }
})
