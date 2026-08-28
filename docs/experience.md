# Experience — Lessons & History

Record what you learn as you build: patterns that work, ideas that didn't pan out, and a version history of major changes.

## What Didn't Work (Gotchas & Dead Ends)

### Mobile-First Design Constraints

Touch targets need to be at least 44×44px. Avoid hover-only interactions — users on mobile have no hover. Rethink interactions like "expand on hover" as "toggle on tap" or always-expanded. Test regularly on actual mobile devices, not just the browser's responsive mode.

### Service-Worker Caching & Stale Builds

A PWA caches aggressively to work offline. If a user opens your app, then you deploy a new version, the old bundle may keep serving until they:
- Manually tap "Reload latest" (we surface this in the footer)
- Force-refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
- Open in a private/incognito tab
- Wait for the service worker to auto-update (can take hours)

Always surface a visual "update ready" affordance so users know to reload. See `App.vue` for the implementation.

### ECharts Gotchas (if using charts)

On a **category x-axis**, `visualMap` (color ranges) and per-segment `lineStyle` colors do **not** bind as expected. If you need per-point coloring on a category axis, use a series with per-point `itemStyle` instead. Register new chart types explicitly with `echarts.use([LineChart, ...])` — ECharts doesn't auto-register components.

### Pure Logic vs. Components

Logic lives in `src/lib/` as plain functions over already-fetched arrays. They recompute instantly with no API refetch. Keep components thin — they should mostly render. This separation makes logic testable and reusable without rebuild cycles.

### Don't Hand-Write a Static `public/manifest.json`

`vite-plugin-pwa` generates `manifest.webmanifest` and injects its own `<link rel="manifest">`. A second static `public/manifest.json` linked from `index.html` produces two competing manifest links in the built HTML, and the static one wins in some browsers — pointing at icons the build never processed. Define the manifest once, in the `VitePWA({ manifest: ... })` block.

### `npm ci` Needs a Committed Lockfile

The CI workflow runs `npm ci`, which fails outright ("can only install packages when your package.json and package-lock.json are in sync") if `package-lock.json` isn't committed. It's tempting to gitignore lockfiles; don't. Commit it whenever dependencies change.

### `declaration: true` in an App's tsconfig

Emitting declarations for an *app* makes `vue-tsc` demand exported names for every type used in a component's public surface — a `defineProps` interface that isn't exported fails with `TS4082: Default export of the module has or is using private name 'Props'`. Declarations matter for libraries, not apps. Dropping `declaration`/`declarationMap` is the fix, not exporting every internal interface.

### Ambient Types for Build-Time Constants

`__BUILD_ID__` and `__BUILD_TIME__` are injected by Vite's `define`, and `virtual:pwa-register` only exists at build time. TypeScript knows about none of them without an `src/env.d.ts` declaring the constants and referencing `vite/client` and `vite-plugin-pwa/client`. Without it the build fails with `TS2304: Cannot find name '__BUILD_ID__'`.

### Importing a Markdown Doc as Text Needs Its Own Ambient Type

`vite/client`'s ambient types cover common asset extensions (`.svg`, `.png`, …) but not `.md`, and
not the `?raw` suffix generically. `import overviewDoc from '../../docs/concepts/overview.md?raw'`
works fine at runtime (Vite inlines the file as a string) but fails `vue-tsc` with "Cannot find
module" until `src/env.d.ts` declares `declare module '*.md?raw' { const content: string; export
default content }`. Same shape as the `__BUILD_ID__` entry above: Vite's runtime behavior and
TypeScript's view of the world are two separate things, and a working build doesn't mean a passing
type-check until both agree.

### Rebuilding the Chat Model for a Hidden Membership Graph

The original chat flow (v0.2.0) had a real limitation once the goal became "hide which sessions an
account belongs to from anyone with just database access": `sessions.starter_public_key` /
`joiner_public_key` and the pairwise-ECDH-derived message key both assumed exactly two people whose
public keys sit in plain, joinable columns. Extending that to a hidden index or more than two
participants wasn't a migration — it needed a different foundation. Since no real data existed yet
(nothing to lose), the whole schema and crypto layer were rebuilt from `main` rather than patched.

**A full cryptographic-capability design was evaluated and deliberately scoped down.** A detailed
proposal (Ed25519/X25519/XChaCha20-Poly1305, HKDF-derived permission capabilities like
`K_INVITE_MEMBER`/`K_GRANT_ADMIN`, signed authorization chains, a Supabase Edge Function as the
sole server-side verifier) was reviewed for structural feasibility. Nothing in it was impossible in
this stack — Ed25519/X25519 exist in current browsers' Web Crypto, and P-256 ECDH + AES-256-GCM
(already proven here) give equivalent guarantees without adding a library. The one piece that
needed genuinely new infrastructure was server-side verification: this project has zero backend
code today, everything runs through `using (true)` RLS, and Postgres can't verify a signature
without an extension or an Edge Function. The decision was to skip that layer *and* the
fine-grained capability/signature system it exists to enforce — without a verifier, "only some
members can invite" is a UI suggestion, not a real boundary, since anyone holding the session's
shared key can write a valid-looking access row regardless of what their own copy claims. Both are
recorded as an explicit future feature rather than half-built now.

**The core privacy property survives without any of that**, because it doesn't depend on a
verifier — it depends on encryption plus one non-obvious lookup trick, both provable client-side:

- **A public key is derivable from a private key's JWK alone.** An EC private key's JWK export
  already contains `x`/`y` (the public half) alongside `d` (the private scalar) — so a personal
  link only ever needs to carry the private key. No session id, no role, nothing else, and the
  earlier per-chat `role: 'starter' | 'joiner'` param in the URL disappears entirely.
- **The lookup key for "which sessions does this identity have" can't be the identity's real
  public key**, because that's already public (needed for "start a session targeted at this
  key"), and using it as a search column would let anyone who knows it run exactly that query.
  `deriveLookupTag(privateKey, purpose)` — SHA-256 of the private scalar plus a purpose string —
  is stable (same identity always re-derives the same tag) but requires the private key to
  compute, so the public key alone gives no way to search for it. No new primitive, just a hash,
  and it's what actually closes the correlation gap the capability-doc's `session_access` design
  was reaching for.

Both were verified end-to-end with a standalone script before being wired into the app: seal/open
round-trips, a derived public key working for real ECDH, the lookup tag being stable per identity
but different per purpose and per identity, and — the actual security property — a third party who
finds someone else's `session_access` row still cannot open it, and cannot compute their own way to
someone else's tag from a public key alone.

**One shared session key, not a key per pair, replaces the old "ECDH result is the message key"
scheme.** Whoever creates a session generates one random AES-256 key; every participant gets a
sealed copy specific to their own public key (`sealForRecipient`/`openSealed` — the same ECIES
pattern the design doc described, minus the parts that needed a verifier). This is also what
removed the old "waiting for the other person to join" state entirely: since the key isn't derived
from a second person's public key, the creator has full access to their own session — and can start
typing — the instant it's created.

**A whole-JWK string comparison silently broke identity matching.** Stage A's live 3-person test
showed every participant as a generic "Someone" except "mine" (which worked by accident). The cause:
one code path compared `JSON.stringify(publicJwkFromPrivateJwk(jwk))` (a hand-rolled object literal)
against `JSON.stringify(await exportPublicKey(key))` (the browser's native `exportKey`) — same key,
different field insertion order (`key_ops,ext,kty,x,y,crv` vs. `kty,crv,x,y,ext,key_ops`), so
`JSON.stringify` never matched even though the key did. "Mine" only worked because both sides of
that one comparison happened to go through the same hand-rolled function. Fixed with
`canonicalPublicKeyId(jwk) = \`${jwk.x}.${jwk.y}\`` — compare only the two fields that actually
identify a P-256 key — used at every identity-string call site. Verified with a script reproducing
the exact field-order mismatch before touching the app, then a 3-participant simulation after the
fix. Lesson: never compare two JWKs (or their JSON) for identity; compare their key material.

## Version History

(Record major releases here as you merge features. Example format below.)

### v0.6.0 — 2026-08-28 (Stage C: guest → account migration)
- **Added:** `migrateGuestSessionToAccount` (`src/api/sessionActions.ts`) — adds an account's own
  `session_access` row to a session it currently only holds as a guest, plus a new
  `session_participants` row for the account's real key; the guest's original row is never touched
- **Fixed a real, already-shipped vulnerability, found through the user's own architecture review of
  this table:** `session_participants.public_key` stored an account's real public key in plaintext.
  Because an account reuses that same key across every session it joins, and RLS is `using (true)`,
  anyone with database access could run `select session_id from session_participants where
  public_key = X` and recover the exact membership graph `session_access`'s lookup-tag design exists
  to hide — for every account, though not guests (one-off keys per session). Fixed by symmetrically
  encrypting each row's identity with the session's own shared key, reusing `encryptText`/
  `decryptText` (the exact functions `messages` already use) instead of ECDH sealing — no
  `ephemeral_public_key` needed, since anyone holding the session key is already a legitimate
  participant. `session_id` stays a plaintext lookup column (existence/count, not identity, same
  accepted leak as `messages.session_id`). Verified with a standalone script: no plaintext identity
  recoverable from a raw row dump, a legitimate session-key holder decrypts correctly, the wrong
  session's key fails outright. See "`session_participants` is keyed by plaintext `session_id`" in
  `docs/system-design.md` §3
- **Added:** `+ Add to account` control on `SessionView.vue` (a guest-routed session only): one tap
  if already logged in, or paste-an-account-link-and-log-in-then-migrate if not
- **Redesigned (twice, after live testing) how a message's sender name is determined.** First pass
  baked a `senderName` into each message at send time — fixed the reported "migrated identity's new
  messages still show the old guest name" bug, but froze names as historical snapshots. Second pass,
  prompted by a sharper design from live testing, replaced that with fully live resolution: a
  message carries only `sender` (its public key); `SessionView.vue`'s `nameFor` resolves that key
  against `accounts` every time, falling back to `guestNameForKey` — a deterministic, storage-free
  name hashed from the key itself — when it isn't one. `session_participants` has never stored a
  name; `sessionList.ts`'s chat-list preview uses the exact same resolution as the thread, closing a
  gap the first pass had left open
- **Added:** `guestNameForKey` (`src/lib/guestName.ts`) replaces `randomGuestName` — same word lists,
  but deterministic (a hash of the public key, not `Math.random()`) so no name needs to be generated
  or stored at join time at all, and a 3-character base36 suffix on top of color×noun to cut
  collisions among many guest identities
- **Added:** `truncateName` (`src/lib/guestName.ts`) — resolved names are capped at 20 characters
  with a trailing `…` wherever the thread renders one, since an account's username is arbitrary length
- See "An account can migrate a guest session it already holds" and "A message's displayed sender
  name is resolved live" in `docs/system-design.md` §3 for the full design and why identity pinning
  ended up scoped to "mine" detection only, never to what a message displays

### v0.5.0 — 2026-08-28 (Stage B: accounts + hidden session index)
- **Added:** accounts (`src/api/accounts.ts`, `src/lib/auth.ts`) — a keypair + username identity
  that reuses the guest session-access mechanism verbatim, except the keypair is stable across
  every session it touches
- **Added:** `AccountHome.vue`, a chat list built entirely client-side by
  `src/api/sessionList.ts` decrypting an account's own `session_access` rows — the server-side
  query is still just "how many rows does this tag have"
- **Added:** `#/mysession/<sessionId>` route + `#/account/<packedKey>` route (`src/lib/route.ts`);
  `SessionView.vue` now accepts either a guest `packedKey` or an account `sessionId` prop, and hides
  the personal-link Warning control for the latter (recoverable via the account link instead)
- **Added:** `src/api/sessionActions.ts` — shared `startNewSession`/`joinExistingSession` so guest
  and account identities go through identical seal/lookup-tag/participant steps, called from both
  `SessionHome.vue`/`JoinSession.vue` (guest) and `AccountHome.vue` (account)
- **Extended:** `SessionAccessPayload` gained an optional `title` field, stored in the same sealed
  envelope — no new table needed for a session's display name
- **Added:** `Join as guest` / `Join as existing user` / `Join as <username>` choice on
  `JoinSession.vue` — "existing user" logs in on the spot from a pasted account link
  (`loginWithPackedKey`) and then joins with that account, so a device that's never logged in
  doesn't have to bounce through the home screen first
- **Fixed (found in live testing):** invite links were multi-use and never expired; redeeming one
  deleted the row, which made a reused link indistinguishable from one that never existed and
  crashed the read query. Replaced with `claimJoinAccess` — an atomic
  `UPDATE ... WHERE consumed_at IS NULL ... RETURNING` (needs a new `join_access.consumed_at`
  column) — plus a 10-minute TTL via `isJoinAccessExpired`, so a link is genuinely single-use, a
  real "already used" vs. "expired" vs. "never existed" message shows correctly, and Postgres
  itself (not app logic) decides which of two simultaneous claims wins
- **Fixed (found in live testing):** an account re-opening an invite link it already held access to
  (most often its own, right after creating the session) kept sealing and inserting duplicate
  `session_access`/`session_participants` rows. `joinExistingSession` now checks the account's own
  decrypted rows for a `sessionId` match first and resolves straight there instead
- **Fixed (found in live testing):** an account holder's messages showed as "Someone" instead of
  their username — `display_name` is deliberately left `null` for account holders (resolved live),
  but `SessionView.vue` was reading it with `?? 'Someone'` and never actually doing that
  resolution. `applyParticipant` now calls `fetchAccountByPublicKey` for a null `display_name`, and
  the participant-name map became a Vue `reactive()` Map so the thread re-renders once the lookup
  resolves instead of a message's sender name staying baked in from before it finished
- **Expanded:** guest name word lists (`src/lib/guestName.ts`) from 16×16 to 31 colors × 149
  animals/flowers
- See "An account is just another identity" and "Why a personal link isn't enough" in
  `docs/system-design.md` §3 for the full design reasoning

### v0.4.0 — 2026-08-27 (Stage A of the session-model rebuild)
- **Rebuilt:** the entire chat data model and crypto layer around a hidden membership graph and a
  shared per-session key — see "Rebuilding the Chat Model for a Hidden Membership Graph" above and
  §3 in `docs/system-design.md` for the full design
- **Renamed:** chat → session throughout — routes (`#/session/...`, `#/join/...`), components
  (`SessionHome.vue`, `JoinSession.vue`, `SessionView.vue`), tables (`session_access`,
  `session_participants`, `join_access`)
- **Removed:** the old two-party-only `sessions.starter_public_key`/`joiner_public_key` shape, the
  "waiting for the other person to join" state, and the `role: starter|joiner` URL parameter
- **Added:** guest display names (`randomGuestName`), an Invite/Warning control pair on the session
  view replacing the old two-link intermediate screen — opening one closes the other, and clicking
  outside either closes whichever is open
- **Fixed:** a whole-JWK string comparison was silently breaking identity matching, showing every
  guest as "Someone" — see `canonicalPublicKeyId` above
- **Deferred (tracked in `docs/TODO.md`):** accounts, guest→account migration, multi-participant
  invites with an accept/view-only flow, server-side capability verification

### v0.2.1 — 2026-08-23
- **Fixed:** The message composer's Enter key sent on every platform, including mobile, where
  there's no reliable Shift+Enter. Now branches on `matchMedia('(pointer: coarse)')`: touch devices
  always treat Enter as a newline (Send button is the only way to send); desktop sends on Enter and
  inserts a newline on Shift+Enter.

### v0.2.0 — 2026-08-23
- **Added:** The core encrypted chat flow — Start a chat / Join a chat / Chat view, wired to a
  hash-based router (no `vue-router` needed for three screens)
- **Crypto:** ECDH (P-256) key agreement + AES-GCM message encryption in `src/lib/crypto.ts`;
  private keys never leave the browser, carried only in each participant's personal link
- **Infrastructure:** Supabase (`sessions`, `messages` tables, link-only RLS, realtime) as the
  shared backend so two browsers can sync a conversation
- **Docs:** Help modal now renders the real `docs/concepts/overview.md` instead of a placeholder
  string; `docs/system-design.md` documents the data/trust model (§3a)

### v0.1.0 — [Date]
- **Added:** Initial scaffold, header/footer wrapper, Help modal
- **Infrastructure:** Netlify (production + preview deploys), branch-protected `main`
- **Docs:** TODO, experience, system-design, concepts scaffold

---

*Tip: When you abandon a branch or realize something didn't work, add a short "What didn't work" entry above so future-you (or a teammate) doesn't re-walk the same dead end.*
