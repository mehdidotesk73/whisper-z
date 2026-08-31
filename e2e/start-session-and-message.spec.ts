import { test, expect } from './fixtures'

// Smallest end-to-end proof that the app's write path (start a session, send
// a message) and read/render path (the message showing up in the thread) are
// coherent against the live database — see docs/system-design.md's "How E2E
// tests are structured" for how this fits alongside Vitest's pure-logic
// tests. More scenarios (guest join, invites, account adoption) land here as
// their own spec files once this pattern is proven out.
test('starting a session and sending a message renders it in the thread', async ({ page, manifest }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Start a session' }).click()
  await expect(page).toHaveURL(/#\/session\//)

  const packedKey = page.url().split('#/session/')[1]
  manifest.track(packedKey)

  const messageText = `e2e message ${Date.now()}`
  await page.getByPlaceholder('Message…').fill(messageText)
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.bubble.mine')).toContainText(messageText)
})
