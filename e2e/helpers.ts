// Shared Playwright actions for the app's UI flows — factored out so each
// scenario spec reads as its own story instead of re-deriving selectors.
// See docs/system-design.md §7 for how these tests fit alongside Vitest's
// pure-logic coverage, and e2e/fixtures.ts for how cleanup works.
import type { Page } from '@playwright/test'
import { expect } from './fixtures'

// Every action here does at least one real round trip to the live Supabase
// project (see playwright.config.ts) — an insert, a select, or (for a sent
// message) a Realtime echo, which is never optimistic anywhere in this app
// (see start-session-and-message.spec.ts's flakiness writeup in
// docs/experience.md). CI has shown that a plain round trip can occasionally
// take a few seconds, not just the Realtime one — so every wait in this file
// uses this instead of Playwright's 5s default, not only the ones that
// happen to be message-related.
export const NETWORK_TIMEOUT = 20000

/**
 * Reads the app's own on-screen debug log (see src/debug.ts and "Debugging
 * on device (no console)" in CLAUDE.md) — every Vue error, console.error/warn,
 * window error, and unhandled rejection the app itself has seen, with the
 * real exception detail (name, message, a few stack frames), not just
 * whatever static UI text a catch block chose to show. Opens the footer's
 * "View logs" panel if it isn't already open. The single most useful tool
 * for a test that times out with no other clue why: the app was very
 * possibly already logging the real reason the whole time.
 */
export async function getDebugLogText(page: Page): Promise<string> {
  const isOpen = await page.locator('.log-window').isVisible()
  if (!isOpen) await page.getByRole('button', { name: 'View logs' }).click()
  return page.locator('.debug-log').innerText()
}

/** Just the error/warn lines from the debug log — usually all that's needed to diagnose a failure. */
export async function getDebugErrors(page: Page): Promise<string[]> {
  const isOpen = await page.locator('.log-window').isVisible()
  if (!isOpen) await page.getByRole('button', { name: 'View logs' }).click()
  return page.locator('.debug-log li.error, .debug-log li.warn').allTextContents()
}

/**
 * accounts.username is globally unique in the live database — always
 * generate one, never hardcode. Kept under guestName.ts's 20-character
 * truncateName limit (a base36 timestamp + a short random suffix, not the
 * full decimal Date.now()) so an assertion comparing against the exact
 * username isn't broken by the app's own — entirely correct — truncation.
 */
export function uniqueUsername(prefix: string): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 5)
  return `${prefix}-${timestamp}-${random}`
}

/** From the logged-out home screen: creates an account, returns its account link. */
export async function createAccount(page: Page, username: string): Promise<string> {
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByPlaceholder('Pick a username').fill(username)
  await page.getByRole('button', { name: 'Create account' }).click()

  const linkInput = page.locator('input[readonly]')
  await expect(linkInput).toBeVisible({ timeout: NETWORK_TIMEOUT })
  const accountLink = await linkInput.inputValue()

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Signed in as')).toBeVisible({ timeout: NETWORK_TIMEOUT })
  return accountLink
}

/** From anywhere an account is signed in: logs out back to the home screen. */
export async function logOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out' }).click()
}

/** From the logged-out home screen: logs in with an account link (or bare key). */
export async function logIn(page: Page, accountLinkOrKey: string): Promise<void> {
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByPlaceholder('Paste your account link or key').fill(accountLinkOrKey)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByText('Signed in as')).toBeVisible({ timeout: NETWORK_TIMEOUT })
}

/** From AccountHome: starts a session, returns the sessionId from the `#/mysession/<id>` URL. */
export async function startSessionAsAccount(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Start a session' }).click()
  await expect(page).toHaveURL(/#\/mysession\//, { timeout: NETWORK_TIMEOUT })
  return page.url().split('#/mysession/')[1]
}

/** From the logged-out home screen: starts a session as a guest, returns the packed key from the URL. */
export async function startSessionAsGuest(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Start a session' }).click()
  await expect(page).toHaveURL(/#\/session\//, { timeout: NETWORK_TIMEOUT })
  return page.url().split('#/session/')[1]
}

/**
 * From an open SessionView: sends a message and waits for it to render as
 * your own bubble. Scoped to a bubble containing this exact text (every
 * caller uses a `Date.now()`-suffixed message, so it's unique) rather than
 * asserting on `.bubble.mine` as a whole — a page can already have more than
 * one "own" bubble by the time this is called (e.g. after adopting a guest
 * identity, its earlier messages become "mine" too), and asserting on the
 * whole locator then fails as a strict-mode violation, not a timeout.
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder('Message…').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.bubble.mine').filter({ hasText: text })).toBeVisible({ timeout: NETWORK_TIMEOUT })
}

/** From an open SessionView: waits for a message (any sender) to appear in the thread. */
export async function expectMessageVisible(page: Page, text: string): Promise<void> {
  await expect(page.locator('.bubble').filter({ hasText: text }).first()).toBeVisible({ timeout: NETWORK_TIMEOUT })
}

/** From an open SessionView: waits for a message to appear rendered as this viewer's own (no sender label). */
export async function expectOwnMessageVisible(page: Page, text: string): Promise<void> {
  await expect(page.locator('.bubble.mine').filter({ hasText: text }).first()).toBeVisible({
    timeout: NETWORK_TIMEOUT,
  })
}

/**
 * From an open SessionView: waits for a message rendered as someone else's,
 * and asserts the sender label shown next to it — the resolved display name
 * (a live username lookup, or the deterministic guest-name fallback), not
 * the raw public key.
 */
export async function expectMessageSender(page: Page, text: string, expectedSenderName: string): Promise<void> {
  const bubble = page.locator('.bubble.theirs').filter({ hasText: text }).first()
  await expect(bubble).toBeVisible({ timeout: NETWORK_TIMEOUT })
  await expect(bubble.locator('.sender')).toHaveText(expectedSenderName, { timeout: NETWORK_TIMEOUT })
}

/** From a guest SessionView: opens the personal-link warning panel and returns the link. */
export async function getPersonalLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: '⚠ Warning' }).click()
  const input = page.locator('.warning-block input[readonly]')
  await expect(input).toBeVisible({ timeout: NETWORK_TIMEOUT })
  return input.inputValue()
}

/** From an open SessionView: generates/reads a join link via the Invite menu. */
export async function getJoinLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite ▾' }).click()
  await page.getByRole('button', { name: 'By join link' }).click()
  const input = page.locator('.modal-box input[readonly]')
  await expect(input).not.toHaveValue('Generating…', { timeout: NETWORK_TIMEOUT })
  const link = await input.inputValue()
  await page.getByRole('button', { name: 'Close' }).click()
  return link
}

/** From an open SessionView: sends a public-key invite to the given (packed) public key blob. */
export async function sendInviteByKey(page: Page, publicKeyBlob: string): Promise<void> {
  await page.getByRole('button', { name: 'Invite ▾' }).click()
  await page.getByRole('button', { name: 'By public key' }).click()
  const input = page.getByPlaceholder('Paste their public key')
  await input.fill(publicKeyBlob)
  const sendButton = page.getByRole('button', { name: 'Send invite' })

  // SessionView.vue's sendInviteByKey() silently no-ops — no error, no log
  // entry, nothing — if the pasted value is empty or its own ownPrivateKey/
  // sessionKeyJwk state is unset. That's indistinguishable from a hung
  // network call by symptom alone (both just sit there), which is exactly
  // what made this fail three times with no other clue why. Rule out "the
  // paste didn't take" or "the button was disabled" before clicking, so a
  // failure past this point can only be the app's own internal state.
  const actualValue = await input.inputValue()
  const isDisabled = await sendButton.isDisabled()
  if (actualValue !== publicKeyBlob || isDisabled) {
    throw new Error(
      `sendInviteByKey: precondition failed before clicking Send invite — ` +
        `input value ${actualValue === publicKeyBlob ? 'matches' : `MISMATCH (${actualValue.length} chars pasted, ${publicKeyBlob.length} expected)`}, ` +
        `button disabled=${isDisabled}`,
    )
  }
  await sendButton.click()

  // Wait for whichever of the two outcomes the app actually renders, rather
  // than only waiting for success and letting a real app-side error (shown
  // in `.modal-box .error`) surface as an opaque timeout with no diagnosis.
  const sentText = page.getByText('Invite sent to')
  const errorText = page.locator('.modal-box .error')
  await expect(sentText.or(errorText)).toBeVisible({ timeout: NETWORK_TIMEOUT })
  if (await errorText.isVisible()) {
    const uiError = await errorText.textContent()
    const debugErrors = await getDebugErrors(page)
    throw new Error(
      `sendInviteByKey: the app reported an error instead of sending: "${uiError}"\n` +
        (debugErrors.length ? `App debug log:\n${debugErrors.join('\n')}` : '(debug log had no error/warn entries)'),
    )
  }
  await page.getByRole('button', { name: 'Close' }).click()
}

/**
 * From AccountHome: opens the Account menu's "My public key" panel and
 * returns the blob. The modal (and its readonly input) becomes visible the
 * instant it opens, but `myPublicKeyBlob` is populated by a separate async
 * onMounted a moment later — waiting only for visibility can read an empty
 * string, which then gets pasted into "Invite by key" whose Send button
 * stays disabled on an empty paste, so nothing ever happens. Wait for the
 * value itself, the same pattern getJoinLink already uses for "Generating…".
 */
export async function getMyPublicKey(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Account ▾' }).click()
  await page.getByRole('button', { name: 'My public key' }).click()
  const input = page.locator('.modal-box input[readonly]')
  await expect(input).not.toHaveValue('', { timeout: NETWORK_TIMEOUT })
  const key = await input.inputValue()
  await page.getByRole('button', { name: 'Close' }).click()
  return key
}

/**
 * From AccountHome: reloads (checkForInvites only runs on mount, so a
 * pending invite sent after the page last loaded needs a fresh mount to
 * surface) and accepts the first pending invite. Returns the sessionId.
 */
export async function acceptPendingInvite(page: Page): Promise<string> {
  await page.reload()
  const acceptButton = page.getByRole('button', { name: 'Accept' })
  await expect(acceptButton).toBeVisible({ timeout: NETWORK_TIMEOUT })
  await acceptButton.click()
  await expect(page).toHaveURL(/#\/mysession\//, { timeout: NETWORK_TIMEOUT })
  return page.url().split('#/mysession/')[1]
}

/** Navigates to a join link and joins as a throwaway guest. Returns the packed key from the URL. */
export async function joinAsGuestViaLink(page: Page, joinLink: string): Promise<string> {
  await page.goto(joinLink)
  await page.getByRole('button', { name: 'Join as guest' }).click()
  await expect(page).toHaveURL(/#\/session\//, { timeout: NETWORK_TIMEOUT })
  return page.url().split('#/session/')[1]
}

/** From AccountHome: adopts a guest identity (by its personal link or bare key) via the Account menu. */
export async function adoptGuestFromAccountSide(page: Page, guestPersonalLinkOrKey: string): Promise<void> {
  await page.getByRole('button', { name: 'Account ▾' }).click()
  await page.getByRole('button', { name: 'Adopt guest account' }).click()
  await page.getByPlaceholder('Paste their private key or personal link').fill(guestPersonalLinkOrKey)
  await page.getByRole('button', { name: 'Adopt account' }).click()
  // The modal closes itself on success (showAdoptModal.value = false) — its
  // input disappearing is the confirmation, there's no separate success text.
  await expect(page.getByPlaceholder('Paste their private key or personal link')).toHaveCount(0, {
    timeout: NETWORK_TIMEOUT,
  })
}

/** From a guest SessionView: merges this guest identity into an account via "+ Add to account". */
export async function addToAccountFromGuestSide(page: Page, accountLinkOrKey: string): Promise<void> {
  await page.getByRole('button', { name: '+ Add to account' }).click()
  await page.getByPlaceholder('Paste your account link').fill(accountLinkOrKey)
  await page.getByRole('button', { name: 'Log in & add' }).click()
  await expect(page).toHaveURL(/#\/mysession\//, { timeout: NETWORK_TIMEOUT })
}
