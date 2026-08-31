import { test, expect } from './fixtures'
import { createAccount, startSessionAsAccount, getJoinLink, joinAsAccountViaLink, uniqueUsername } from './helpers'

// Regression for alreadyHasAccess (src/api/sessionActions.ts): "An account's
// tag is stable, so opening an invite link to a session it already holds
// (e.g. the owner re-opening their own invite, or a link shared twice) would
// otherwise just add a duplicate session_access + session_participants row
// on every visit." Locks in that re-opening your own join link while still
// logged in as the same account no-ops instead of duplicating.
test('re-opening your own join link does not duplicate session access', async ({ page, manifest }) => {
  await page.goto('/')

  const accountLink = await createAccount(page, uniqueUsername('acct'))
  manifest.track(accountLink)
  await startSessionAsAccount(page)

  const ownJoinLink = await getJoinLink(page, manifest)

  // Same account, same browser, still logged in — re-opening its own link.
  await joinAsAccountViaLink(page, ownJoinLink)

  await page.getByRole('button', { name: '← Home' }).click()
  await expect(page.locator('.list .row')).toHaveCount(1)
})
