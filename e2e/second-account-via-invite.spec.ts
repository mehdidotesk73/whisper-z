import { test } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getMyPublicKey,
  sendInviteByKey,
  acceptPendingInvite,
  sendMessage,
  expectMessageVisible,
  uniqueUsername,
} from './helpers'

// Covers: a second account is invited directly by public key (not a link —
// Stage D's out-of-band invite), accepts it from its own pending-invites
// list, and messages from both accounts render for both sides.
test('a second account joins via a public-key invite and messages render for both', async ({
  page,
  browser,
  manifest,
}) => {
  await page.goto('/')

  const account1Link = await createAccount(page, uniqueUsername('acct1'))
  manifest.track(account1Link)
  await startSessionAsAccount(page)
  const firstMessage = `from account1 ${Date.now()}`
  await sendMessage(page, firstMessage)

  const account2Context = await browser.newContext()
  const account2Page = await account2Context.newPage()
  try {
    await account2Page.goto('/')
    const account2Link = await createAccount(account2Page, uniqueUsername('acct2'))
    manifest.track(account2Link)
    const account2PublicKey = await getMyPublicKey(account2Page)

    await sendInviteByKey(page, account2PublicKey)
    manifest.trackInvite(account1Link, account2Link)

    await acceptPendingInvite(account2Page)
    await expectMessageVisible(account2Page, firstMessage)

    const secondMessage = `from account2 ${Date.now()}`
    await sendMessage(account2Page, secondMessage)
    await expectMessageVisible(page, secondMessage)
  } finally {
    await account2Context.close()
  }
})
