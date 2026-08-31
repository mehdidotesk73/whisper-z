import { test, expect } from './fixtures'
import { createAccount, startSessionAsAccount, sendMessage, uniqueUsername } from './helpers'

// Covers: an account with two separate sessions sees both in AccountHome's
// chat list (sessionList.ts pushes one item per session_access row — no
// deduplication), sorted by most recent message first, and tapping a row
// opens the right session (the `#/mysession/<id>` disambiguation Stage B
// added once an account can hold more than one session).
test('an account with two sessions sees both in its chat list, sorted by latest activity', async ({
  page,
  manifest,
}) => {
  await page.goto('/')

  const accountLink = await createAccount(page, uniqueUsername('acct'))
  manifest.track(accountLink)

  const sessionIdA = await startSessionAsAccount(page)
  await sendMessage(page, `session A message ${Date.now()}`)

  await page.getByRole('button', { name: '← Home' }).click()
  const sessionIdB = await startSessionAsAccount(page)
  await sendMessage(page, `session B message ${Date.now()}`)

  await page.getByRole('button', { name: '← Home' }).click()
  const rows = page.locator('.list .row')
  await expect(rows).toHaveCount(2)

  // B was messaged more recently than A — sessionList.ts sorts descending
  // by latest message, so B's row comes first.
  await rows.nth(0).click()
  await expect(page).toHaveURL(new RegExp(`#/mysession/${sessionIdB}`))

  await page.getByRole('button', { name: '← Home' }).click()
  await rows.nth(1).click()
  await expect(page).toHaveURL(new RegExp(`#/mysession/${sessionIdA}`))
})
