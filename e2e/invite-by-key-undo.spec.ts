import { test, expect } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getMyPublicKey,
  sendInviteByKeyThenUndo,
  uniqueUsername,
  NETWORK_TIMEOUT,
} from './helpers'

// Covers: undoLastInvite (SessionView.vue) — sending a public-key invite
// then undoing it immediately deletes the session_invites row (see its doc
// comment: "not a real cancel — an undo... only works while this exact
// invite is still in memory, right here, right after sending"). Confirms
// the invited party never sees it as pending.
test('undoing a public-key invite right after sending it leaves nothing pending', async ({
  page,
  browser,
  manifest,
}) => {
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

    await sendInviteByKeyThenUndo(page, account2PublicKey)
    // Defensive — undoLastInvite already deletes the row itself; this is a
    // no-op if that already succeeded, a real cleanup if it somehow didn't.
    manifest.trackInvite(account1Link, account2Link)

    // No positive signal exists for "the invite check finished and found
    // nothing" (unlike the session list's own "No sessions yet" empty
    // state) — waiting for that empty state as a proxy for "AccountHome's
    // mount-time fetches have had time to settle" before asserting the
    // invite itself is absent is the closest thing available.
    await account2Page.reload()
    await expect(account2Page.getByText('No sessions yet')).toBeVisible({ timeout: NETWORK_TIMEOUT })
    await expect(account2Page.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  } finally {
    await account2Context.close()
  }
})
