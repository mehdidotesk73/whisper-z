import { test } from './fixtures'
import { createAccount, logOut, logIn, startSessionAsAccount, sendMessage, uniqueUsername } from './helpers'

// Covers: create an account, log out, log back in via the account's own
// personal (account) link, then start a session and send a message as that
// account — the same write/read/render loop as start-session-and-message.spec.ts,
// but through an account identity instead of a one-off guest keypair.
test('creating an account, logging back in via its own link, and messaging', async ({ page, manifest }) => {
  await page.goto('/')

  const accountLink = await createAccount(page, uniqueUsername('acct'))
  manifest.track(accountLink)

  await logOut(page)
  await logIn(page, accountLink)

  await startSessionAsAccount(page)
  await sendMessage(page, `e2e account message ${Date.now()}`)
})
