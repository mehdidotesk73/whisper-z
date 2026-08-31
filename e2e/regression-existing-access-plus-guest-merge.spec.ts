import { test, expect } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getJoinLink,
  joinAsAccountViaLink,
  joinAsGuestViaLink,
  getPersonalLink,
  adoptGuestFromAccountSide,
  sendMessage,
  expectOwnMessageVisible,
  expectMessageSender,
  uniqueUsername,
} from './helpers'
import { unpackJwk, publicJwkFromPrivateJwk, canonicalPublicKeyId } from '../src/lib/crypto'
import { guestNameForKey, truncateName } from '../src/lib/guestName'

// Regression for a real Stage C bug (docs/experience.md's v0.6.0 entry): an
// account that already holds *direct* access to a session (joined it itself,
// under its own key — not via adopting a guest) previously failed to
// recognize a *different* guest identity's messages as its own once adopted,
// because the old single-key identityPublicKeyId field and its too-coarse
// idempotency check silently no-opped instead of merging into an array.
// This locks in the merge-into-the-existing-row fix.
test('an account with direct session access absorbs a different guest identity on adoption', async ({
  page,
  browser,
  manifest,
}) => {
  await page.goto('/')

  // account1: session owner, a plain third-party observer throughout.
  const account1Link = await createAccount(page, uniqueUsername('acct1'))
  manifest.track(account1Link)
  await startSessionAsAccount(page)

  const joinLinkForAccount2 = await getJoinLink(page, manifest)
  const joinLinkForGuest = await getJoinLink(page, manifest)

  const account2Context = await browser.newContext()
  const account2Page = await account2Context.newPage()
  const guestContext = await browser.newContext()
  const guestPage = await guestContext.newPage()
  try {
    // account2 joins DIRECTLY under its own key first — this is exactly the
    // "already has a session_access row for this session" precondition the
    // original bug needed to reproduce.
    await account2Page.goto('/')
    const account2Username = uniqueUsername('acct2')
    const account2Link = await createAccount(account2Page, account2Username)
    manifest.track(account2Link)
    await joinAsAccountViaLink(account2Page, joinLinkForAccount2)

    // A different guest joins separately and leaves real history to check
    // name-attribution on, both before and after the adoption below.
    const guestKey = await joinAsGuestViaLink(guestPage, joinLinkForGuest)
    manifest.track(guestKey)
    const guestPublicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(unpackJwk(guestKey)))
    const expectedGuestName = truncateName(guestNameForKey(guestPublicKeyId))

    const guestHistoryMessage = `guest history ${Date.now()}`
    await sendMessage(guestPage, guestHistoryMessage)
    await expectMessageSender(page, guestHistoryMessage, expectedGuestName)

    const guestPersonalLink = await getPersonalLink(guestPage)

    // adoptGuestFromAccountSide lives on AccountHome's Account menu, not
    // inside a session view — go home first (account2Page is still sitting
    // on the session it joined directly).
    await account2Page.getByRole('button', { name: '← Home' }).click()
    await adoptGuestFromAccountSide(account2Page, guestPersonalLink)

    // The bug this guards against: adopting into an *existing* row must
    // update it in place, not insert a second row for the same session —
    // exactly one entry should ever show up in the chat list.
    await expect(account2Page.locator('.list .row')).toHaveCount(1)
    await account2Page.locator('.list .row').first().click()
    await expect(account2Page).toHaveURL(/#\/mysession\//)

    // The guest's earlier message is now recognized as account2's own.
    await expectOwnMessageVisible(account2Page, guestHistoryMessage)

    const account2NewMessage = `account2 after merge ${Date.now()}`
    await sendMessage(account2Page, account2NewMessage)

    // account1 (untouched by any of this) sees the new message under
    // account2's real username, while the old guest message's sender is
    // unaffected — still resolves to the same deterministic guest name.
    await expectMessageSender(page, account2NewMessage, account2Username)
    await expectMessageSender(page, guestHistoryMessage, expectedGuestName)
  } finally {
    await account2Context.close()
    await guestContext.close()
  }
})
