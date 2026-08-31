import { test } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getJoinLink,
  joinAsGuestViaLink,
  sendMessage,
  expectMessageVisible,
  uniqueUsername,
} from './helpers'

// Covers: an account starts a session, a guest (a genuinely separate browser
// context — no shared localStorage, so JoinSession really offers "Join as
// guest" rather than picking up the account's login) joins via a join link,
// and messages from both sides render for both parties.
test('a guest joins via a join link and messages render for both sides', async ({ page, browser, manifest }) => {
  await page.goto('/')

  const accountLink = await createAccount(page, uniqueUsername('acct'))
  manifest.track(accountLink)
  await startSessionAsAccount(page)

  const joinLink = await getJoinLink(page)
  const joinId = joinLink.split('#/join/')[1].split('/')[0]
  manifest.trackJoinAccess(joinId)

  const guestContext = await browser.newContext()
  const guestPage = await guestContext.newPage()
  try {
    const guestKey = await joinAsGuestViaLink(guestPage, joinLink)
    manifest.track(guestKey)

    const accountMessage = `from account ${Date.now()}`
    await sendMessage(page, accountMessage)
    await expectMessageVisible(guestPage, accountMessage)

    const guestMessage = `from guest ${Date.now()}`
    await sendMessage(guestPage, guestMessage)
    await expectMessageVisible(page, guestMessage)
  } finally {
    await guestContext.close()
  }
})
