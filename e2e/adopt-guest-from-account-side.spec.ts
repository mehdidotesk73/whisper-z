import { test, expect } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getJoinLink,
  joinAsGuestViaLink,
  getPersonalLink,
  adoptGuestFromAccountSide,
  sendMessage,
  expectMessageVisible,
  expectOwnMessageVisible,
  expectMessageSender,
  uniqueUsername,
} from './helpers'
import { unpackJwk, publicJwkFromPrivateJwk, canonicalPublicKeyId } from '../src/lib/crypto'
import { guestNameForKey } from '../src/lib/guestName'

// Covers: an account adopts a guest identity from its own Account menu
// (adoptGuestIdentity — works for any session the guest belongs to, without
// the account already being a participant). The regression this locks in
// (see docs/experience.md's Stage C entry): a third party watching the
// thread should still see the guest's *old* messages under the guest's
// deterministic name, while anything the account sends *after* adopting
// shows the account's own username — nothing here should be a special case
// in the render path, both are just "resolve this sender key" live.
test('an account adopts a guest identity and sender names resolve correctly on both sides', async ({
  page,
  browser,
  manifest,
}) => {
  await page.goto('/')

  // account1: the session creator, never adopts anything — just a
  // third-party observer for checking what other people's names resolve to.
  const account1Link = await createAccount(page, uniqueUsername('acct1'))
  manifest.track(account1Link)
  await startSessionAsAccount(page)

  const joinLink = await getJoinLink(page)
  const joinId = joinLink.split('#/join/')[1].split('/')[0]
  manifest.trackJoinAccess(joinId)

  const guestContext = await browser.newContext()
  const guestPage = await guestContext.newPage()
  const account2Context = await browser.newContext()
  const account2Page = await account2Context.newPage()
  try {
    const guestKey = await joinAsGuestViaLink(guestPage, joinLink)
    manifest.track(guestKey)
    const guestPublicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(unpackJwk(guestKey)))
    const expectedGuestName = guestNameForKey(guestPublicKeyId)

    const guestHistoryMessage = `guest history ${Date.now()}`
    await sendMessage(guestPage, guestHistoryMessage)
    await expectMessageSender(page, guestHistoryMessage, expectedGuestName)

    const guestPersonalLink = await getPersonalLink(guestPage)

    await account2Page.goto('/')
    const account2Link = await createAccount(account2Page, uniqueUsername('acct2'))
    manifest.track(account2Link)
    await adoptGuestFromAccountSide(account2Page, guestPersonalLink)

    // adoptGuestAccount() stays on AccountHome and refreshes the list rather
    // than navigating — open the newly-adopted session from the chat list.
    await account2Page.locator('.list .row').first().click()
    await expect(account2Page).toHaveURL(/#\/mysession\//)

    // The guest's earlier message is now recognized as account2's own.
    await expectOwnMessageVisible(account2Page, guestHistoryMessage)

    const account2Username = (await account2Page.getByText('Signed in as').textContent())
      ?.replace('Signed in as', '')
      .trim()
    const account2NewMessage = `account2 after adopting ${Date.now()}`
    await sendMessage(account2Page, account2NewMessage)

    // account1 (never touched by the adoption) sees the new message under
    // account2's real username, while the old guest message's sender is
    // untouched — still resolves to the same deterministic guest name.
    await expectMessageSender(page, account2NewMessage, account2Username ?? '')
    await expectMessageSender(page, guestHistoryMessage, expectedGuestName)
  } finally {
    await guestContext.close()
    await account2Context.close()
  }
})
