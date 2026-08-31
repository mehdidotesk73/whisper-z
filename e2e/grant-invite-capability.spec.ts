import { test, expect } from './fixtures'
import { createAccount, startSessionAsAccount, getJoinLink, joinAsAccountViaLink, uniqueUsername, NETWORK_TIMEOUT } from './helpers'

// Covers: an admin grants a plain member the 'invite' capability
// (SessionView.vue's "Grant access" panel, api/sessionActions.ts's
// grantCapability/acceptCapabilityGrant). Regression for a real bug found by
// manual testing: the admin's own name leaked into the list of people it
// could grant to, because registerParticipantRow filtered "not me" against
// ownPublicKeyId before that value was actually set for an account-backed
// route (see docs/system-design.md §3's "Stage E" entry).
test('admin grants invite access to a member, who can then invite; admin never appears in its own grant list', async ({
  page,
  browser,
  manifest,
}) => {
  await page.goto('/')
  const adminUsername = uniqueUsername('admin')
  const adminLink = await createAccount(page, adminUsername)
  manifest.track(adminLink)
  await startSessionAsAccount(page)

  const joinLink = await getJoinLink(page, manifest)

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  try {
    await memberPage.goto('/')
    const memberUsername = uniqueUsername('member')
    const memberLink = await createAccount(memberPage, memberUsername)
    manifest.track(memberLink)
    await joinAsAccountViaLink(memberPage, joinLink)

    // A plain member starts with no capability — the Invite menu shouldn't
    // even be offered (SessionView.vue hides it entirely, not just disables it).
    await expect(memberPage.getByRole('button', { name: 'Invite ▾' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Grant access ▾' }).click()
    const grantModal = page.locator('.modal-box')
    await expect(grantModal.getByText(memberUsername)).toBeVisible({ timeout: NETWORK_TIMEOUT })
    // The regression this guards: the admin's own name must never appear
    // as something it could grant access to.
    await expect(grantModal.getByText(adminUsername)).toHaveCount(0)

    const memberRow = grantModal.locator('.grant-row').filter({ hasText: memberUsername })
    await memberRow.getByRole('button', { name: 'Grant invite access' }).click()

    // Not optimistic — same Realtime-echo pattern as every other session_log
    // write in this app (see start-session-and-message.spec.ts's writeup).
    await expect(page.getByText(`${memberUsername} can now send invites`)).toBeVisible({ timeout: NETWORK_TIMEOUT })
    await page.getByRole('button', { name: 'Close' }).click()

    // The grantee's own client picks the grant up over the same Realtime
    // subscription and self-accepts — no reload needed.
    await expect(memberPage.getByRole('button', { name: 'Invite ▾' })).toBeVisible({ timeout: NETWORK_TIMEOUT })
  } finally {
    await memberContext.close()
  }
})
