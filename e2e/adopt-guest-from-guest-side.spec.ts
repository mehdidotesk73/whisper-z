import { test, expect } from './fixtures'
import {
  createAccount,
  startSessionAsAccount,
  getJoinLink,
  joinAsGuestViaLink,
  addToAccountFromGuestSide,
  sendMessage,
  expectMessageVisible,
  expectOwnMessageVisible,
  expectMessageSender,
  uniqueUsername,
} from './helpers'
import { unpackJwk, publicJwkFromPrivateJwk, canonicalPublicKeyId } from '../src/lib/crypto'
import { guestNameForKey, truncateName } from '../src/lib/guestName'

// Covers: the mirror image of adopt-guest-from-account-side.spec.ts — here
// the guest initiates the merge itself, from its own SessionView's
// "+ Add to account" (migrateGuestSessionToAccount via loginThenMigrate),
// by pasting an account's link rather than the account pasting the guest's.
// Same regression locked in either way: a third party's view of the
// guest's pre-merge message keeps the guest's deterministic name, while
// post-merge messages resolve to the account's real username.
test('a guest merges itself into an account and sender names resolve correctly on both sides', async ({
  page,
  browser,
  manifest,
}) => {
  await page.goto('/')

  const account1Link = await createAccount(page, uniqueUsername('acct1'))
  manifest.track(account1Link)
  await startSessionAsAccount(page)

  const joinLink = await getJoinLink(page, manifest)

  const guestContext = await browser.newContext()
  const guestPage = await guestContext.newPage()
  const account2Context = await browser.newContext()
  const account2Page = await account2Context.newPage()
  try {
    const guestKey = await joinAsGuestViaLink(guestPage, joinLink)
    manifest.track(guestKey)
    const guestPublicKeyId = canonicalPublicKeyId(publicJwkFromPrivateJwk(unpackJwk(guestKey)))
    // guestNameForKey's raw output can exceed truncateName's 20-char limit
    // (e.g. "Turquoise" + "Chrysanthemum" + suffix) — apply the same
    // truncation the app renders with, so this doesn't depend on which
    // random key this run happened to hash to.
    const expectedGuestName = truncateName(guestNameForKey(guestPublicKeyId))

    const guestHistoryMessage = `guest history ${Date.now()}`
    await sendMessage(guestPage, guestHistoryMessage)
    await expectMessageSender(page, guestHistoryMessage, expectedGuestName)

    await account2Page.goto('/')
    const account2Link = await createAccount(account2Page, uniqueUsername('acct2'))
    manifest.track(account2Link)

    // From the guest's own browser: log into account2 and merge in one step.
    await addToAccountFromGuestSide(guestPage, account2Link)
    await expect(guestPage.getByText('Signed in as')).toBeVisible()
    await expectOwnMessageVisible(guestPage, guestHistoryMessage)

    const account2Username = (await guestPage.getByText('Signed in as').textContent())
      ?.replace('Signed in as', '')
      .trim()
    const newMessage = `account2 after self-merge ${Date.now()}`
    await sendMessage(guestPage, newMessage)

    await expectMessageSender(page, newMessage, account2Username ?? '')
    await expectMessageSender(page, guestHistoryMessage, expectedGuestName)

    // Cross-context consistency: the same account, opened from a different
    // browser context entirely, sees the merged session and its history too.
    await account2Page.reload()
    await account2Page.locator('.list .row').first().click()
    await expect(account2Page).toHaveURL(/#\/mysession\//)
    await expectOwnMessageVisible(account2Page, guestHistoryMessage)
    await expectMessageVisible(account2Page, newMessage)
  } finally {
    await guestContext.close()
    await account2Context.close()
  }
})
