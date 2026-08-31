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

### A Component-Wide Outside-Click Listener Can Close a Modal It Doesn't Contain

`SessionView.vue` wraps its top-bar buttons and two inline panels (Warning, Migrate) in a
`<div ref="panelArea">`, with `useOutsideClick(panelArea, closeAllPanels)` closing everything when a
click lands outside it. The Invite-by-link, Invite-by-key, and Aliases panels are `<Modal>`
components rendered as *siblings after* `panelArea` closes in the template — not inside it. Since
`useOutsideClick` checks `!panelArea.contains(event.target)`, a click *anywhere inside one of those
open modals* — the input, a button, the text — registers as "outside `panelArea`" and closes the
modal instantly, before the tap could ever reach what it was aimed at. `Modal.vue`'s own backdrop
click (`@click.self`) already closes it correctly on its own; the bug was a second, wider listener
stepping on it. Found through a combination that took real effort to connect: an E2E test kept
timing out on "Invite by key" with no error and an empty debug log (nothing ever threw, because
nothing ever got the chance to run), and the user's own manual test named the actual symptom outright
— tapping anywhere in the modal, including the input, closed it immediately. Fixed by splitting
`closeAllPanels` into that (still used when opening one panel closes the others) and a narrower
`closeInlinePanels` (just Warning/Migrate) for the outside-click listener specifically — the three
Modal-backed panels don't need a second, competing close mechanism at all. General lesson: an
outside-click listener's "root" must actually contain everything that should count as "inside," and a
`<Modal>` rendered as a template sibling — however visually nested — is not automatically inside
anything else's DOM subtree.

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

### Deriving an ECDSA Keypair From a Raw Scalar

Stage E's admin/capability design (`docs/system-design.md` §3) calls for every identity to get a
personal signing keypair *derived* from its existing ECDH private key — not generated independently,
so a personal/account/guest link never needs to carry a second key. The private half is easy: hash
the ECDH private scalar with a purpose string, reduce mod the curve order, done. The public half is
the actual problem: WebCrypto has no "compute a public key from a raw scalar" operation. It only
generates a fresh random keypair, or imports one where the public point is already known (and gets
checked for consistency with the private scalar on import).

The fix exploits an OPTIONAL field: PKCS8's `ECPrivateKey` structure (RFC 5915) has a `[1] publicKey`
field that isn't required. Hand-build a minimal DER PKCS8 envelope carrying only the private scalar,
with that field omitted, and `importKey('pkcs8', ...)` derives and attaches the matching public key
itself — no elliptic-curve math written by hand, no new dependency. Verified with a standalone script
before writing any app code, and — critically — against **real Chromium**, not just Node's OpenSSL-
backed WebCrypto: import succeeds, the key signs, and the exported public half correctly verifies
that signature.

**The one thing this doesn't close: it's unconfirmed on Safari/WebKit**, this app's actual mobile
target, and this sandbox has no way to test that (no network to fetch a WebKit browser, no device).
Different engines can legitimately differ here — the omitted-public-key behavior is a convenience the
spec allows, not one it mandates. Two options were on the table: rely on this native trick and ask for
a real-device check once deployed, or add a small audited EC library (e.g. `@noble/curves`) used
narrowly for just this one operation. Chose the native trick, since it's zero new dependencies and
matches the design as written — but this is a genuine open risk, not a settled fact, until confirmed
on an actual iPhone.

### Signing Is Opportunistic, Not Yet Enforced

Stage E signs every new session_log message with the sender's derived personal signing key, and
`SessionView.vue` verifies incoming ones against the signer's signing key (published in their
`session_participants` row). But this app already has real deployed data — existing sessions, real
message history, real `session_participants` rows written before any of this existed. Retroactively
requiring a signature would have silently deleted a user's own message history the moment this
shipped (no signature exists to check, no signing key was ever published for the sender).

So the rollout is deliberately soft: a message with no `kind`/`signature` at all (the shape every
message had before this feature) is still rendered and trusted, exactly as it always was — nothing
here retroactively distrusts history it can't verify. A new-shape message whose signature fails to
verify against its claimed sender's *known* signing key is dropped (the actual forgery case this
closes). A sender with no known signing key yet — a legacy participant row, or a race with someone
who only just joined — renders unverified rather than being dropped.

**The gap this leaves:** during the transition, a participant holding the shared session key can
still forge another's `sender` by simply omitting `kind`/`signature` and falling back to the old,
unsigned shape — the session itself has no way to force every client to use the new one. Closing this
for real needs either a flag day (reject any message missing a valid signature once enough time has
passed that no legitimate unsigned traffic remains) or an explicit per-session "signing required"
flag set once every participant is known to be on a client that signs. Neither is built yet; this is
an honestly-labeled best-effort improvement, not a hard guarantee — same spirit as this project's
other documented gaps (see `docs/TODO.md`'s Code section: no forward secrecy, no out-of-band key
verification).

### A New Participant's Name Never Resolved Because Nothing Ever Asked

Stage E's grant panel (`SessionView.vue`) lists other participants by name via the same `nameFor` /
`resolveName` pair the thread already uses for message senders. The first CI run of its E2E test
timed out waiting for a just-joined member's username to appear in that list — consistently, on both
the original attempt and its retry, ruling out a flake. First suspicion was `subscribeParticipants`'s
realtime channel never having been exercised before (`subscribeSessionAccess` is also still-unused
dead code, and only `subscribeMessages` is proven to fire by every other test in this suite) — a
plausible Postgres/Supabase-realtime-publication gap, so the panel was changed to pull-refresh
participants via a plain `fetchParticipants` the moment it opens, independent of any subscription.

**That fix was reasonable to keep but didn't touch the actual bug, and CI immediately proved it** —
the exact same failure, unchanged, on the very next run. The real cause: `registerParticipantRow`
(new this stage, feeding the grant panel's participant list) added a public-key id to
`otherParticipantIds` but never called `resolveName` on it. `resolveName` is what triggers the
`accounts` lookup and caches the result — nothing else does. A sender's name resolves correctly only
because `decodeMessage` already calls `resolveName(plain.sender)` for every message it renders; a
participant who hasn't sent a message yet (or been the subject of a grant, the only other call site)
had no path to ever get its real username looked up, and `nameFor` silently fell back to
`guestNameForKey`'s deterministic placeholder forever — exactly the mismatched name ("BlueLavenderJ8V"
next to real usernames like "Mehdi" and "Ava") the user's own manual screenshot had already shown,
which should have been the first clue. Fixed with one line: `registerParticipantRow` now calls
`resolveName(parsed.publicKeyId)` itself, the same way every other path that displays a participant's
name already does.

**Lesson:** two consecutive fixes addressed at the same failing assertion, from a plausible-sounding
infrastructure theory, before actually re-reading what the failing code path does end to end. The
realtime-publication question is still open and worth checking eventually, but it was never what this
particular failure was about — a `getByText(username)` timeout is exactly what "the name was never
looked up" looks like, and that should have been checked before reaching for a database-configuration
explanation.

## Version History

(Record major releases here as you merge features. Example format below.)

### v0.13.0 — 2026-08-31 (pull further skill updates from the template)
- **Synced `.claude/skills/`** again (`update-skills`): adds the new `add-statefulness` skill, which
  works out whether an app needs a database at all (vs. `localStorage`, a document, or realtime)
  before committing to Supabase setup — `add-database` now assumes that decision was already made
  and routes through it. `ship-feature` gained a one-time-per-session check for further skill drift
  and a "consider unit tests" step that offers test-coverage bundles the same way the doc gate offers
  doc surfaces. `update-skills` itself now correctly says a skill update takes effect only in a new
  session with *this project's repo selected*, not just any new conversation — a real correction to
  a previous version of this same skill's own closing message. No app code changed.

### v0.12.0 — 2026-08-31 (pull skill updates from the template)
- **Synced `.claude/skills/`** with the template (`update-skills`): `add-database`, `finish-setup`,
  and `ship-feature` picked up fixes for links and SQL landing dead inside `AskUserQuestion`'s
  plain-text `question` field — the step's content now always goes in a normal message first,
  with the tool call reduced to a one-line gate. `finish-setup` also stopped pruning this file
  against a hardcoded keep-list (it now keeps every entry and only resets Version History) and
  gained a step to fill in `docs/concepts/overview.md` plus a sweep for stray `<REF:...>`
  placeholders. Added the new `share-pattern` skill for writing up a generalizable discovery here
  as a copy-pasteable block for the template repo. No app code changed

### v0.11.0 — 2026-08-31 (multi-actor E2E scenarios + a real modal bug fix)
- **Added:** five more Playwright scenarios against the live Supabase project — account creation +
  re-login via its own link, a guest joining via a join link, a second account joining via a
  public-key invite, and both directions of guest-to-account adoption — plus `e2e/helpers.ts` for the
  shared UI actions they all reuse. `e2e/fixtures.ts`'s `manifest` fixture now also cleans up matching
  `accounts` rows, `join_access` rows, and `session_invites` rows, none of which the original single
  scenario needed to touch
- **Found and fixed a real app bug, not a test bug:** see "A Component-Wide Outside-Click Listener Can
  Close a Modal It Doesn't Contain" above — tapping anywhere inside the Invite-by-link, Invite-by-key,
  or Aliases modal in `SessionView.vue` closed it instantly, before the tap could reach what it was
  aimed at. Surfaced by the new `second-account-via-invite` E2E scenario timing out with no error and
  an empty on-screen debug log across many CI cycles, then confirmed and precisely named through the
  user's own manual test
- **Debug tooling added along the way, worth keeping:** `getDebugLogText`/`getDebugErrors` in
  `e2e/helpers.ts` read the app's own on-screen debug log (`src/debug.ts`) directly from a Playwright
  test — the real exception detail a catch block's static UI text doesn't show. A general `afterEach`
  in `e2e/fixtures.ts` now attaches that log to any failed test's results automatically.
  `.github/workflows/ci.yml` uploads `test-results/` as an artifact on failure — discovered mid-debug
  that this hadn't existed before, so a failure's trace/accessibility-snapshot was never actually
  retrievable
- **A downloadable CI artifact isn't always reachable from here.** GitHub Actions artifacts live on
  Azure Blob Storage, which this sandbox's egress policy blocks — same restriction as the direct
  Supabase block already documented elsewhere. When that happens, get the same information a different
  way: the failing helper now dumps the relevant DOM state directly into its thrown error message,
  which reaches the job log without needing a separate download

### v0.10.0 — 2026-08-30 (Vitest test suite)
- **Added:** `npm test` (Vitest) covering `src/lib/`'s pure logic and the non-Supabase-dependent
  parts of `src/api/sessions.ts`. Every assertion mirrors a claim this session had previously only
  verified with a throwaway `node script.mjs` and discarded — DH reciprocity, seal/open round trips,
  lookup-tag stability per identity/purpose, an uninvolved third party's inability to reproduce a
  pairwise tag or decrypt, the `key_ops`-stripping fix, and the JWK-field-order fix behind
  `canonicalPublicKeyId`. Turning those into permanent tests means a future change that reintroduces
  any of them fails CI immediately, instead of waiting for a live bug report
- **Mocked, not real, coverage for `src/api/`:** a minimal hand-rolled chainable/thenable stand-in for
  supabase-js's query builder, just enough to cover the exact chain shapes `sessions.ts` uses. This
  catches "wrong table or column name" regressions (exactly what the `owner_pub` → `owner_tag` and
  `messages` → `session_log` rename below risked) without needing real Supabase access, which this
  sandbox has never had. It proves nothing about RLS behavior or real schema state — that's still
  only verified by the user's live device testing, unchanged
- **Environment split:** plain Node by default (fast, matches how these functions were always run
  during manual verification) with jsdom opted into per-file (`// @vitest-environment jsdom`) only
  where needed — `route.ts` reads `window.location` and registers a `hashchange` listener at module
  load time, so importing it at all requires a `window` to exist
- Wired into `.github/workflows/ci.yml` as an additional step inside the existing `build` job/check,
  rather than a second required check to configure
- **Found immediately by CI itself:** `ci.yml` was still pinned to Node 20, and jsdom 30 requires
  Node ≥22 — `route.test.ts` (the one file needing jsdom) crashed on CI with `webidl.util.markAsUncloneable
  is not a function`, a jsdom/undici internal that doesn't exist on Node 20, while the other 26
  Node-only tests passed fine. Fixed by bumping `ci.yml` to Node 22 and adding an `engines.node`
  field to `package.json` so the requirement is explicit rather than only discoverable by a red CI
  run. A good first real demonstration of the CI wiring actually catching something
- **Added a second test layer, Playwright, against the live database — deliberately, not for lack of
  a better option.** RLS is `using(true)` everywhere already, so a test-created row is no more exposed
  than any other, and there's no other real user yet whose data a test could collide with; a separate
  test Supabase project would have added real setup for a risk this app doesn't currently have. See
  "End-to-end tests run against the live database" in `docs/system-design.md` §7 for the full
  reasoning, including the FK-cascade check that shaped how cleanup works
- **Cleanup without a database tag.** The obvious "prefix test rows so they're identifiable" doesn't
  work here: every table's `id` is a real `uuid` (type rejects a string prefix), and the columns that
  actually identify ownership (`owner_tag`, etc.) are `SHA-256(privateKey || purpose)` outputs, not
  human-chosen names — you can't tag a hash digest. Instead, `e2e/fixtures.ts`'s `manifest` fixture
  tracks the one thing a test always has right after creating an identity — its packed private
  key — and re-derives that identity's lookup tag at teardown to find and delete everything it
  touched, the same way the app itself would look it up. Considered and rejected: FK-cascade deletes
  from `sessions`/`accounts` alone, since a live check
  (`information_schema.referential_constraints`) showed only `session_log` and `session_participants`
  actually cascade — `session_access`, `join_access`, `session_invites`, and `private_account_state`
  have no enforced FK at all, so a cascade-only cleanup would silently leave most of what a test
  creates behind
- **Couldn't verify the E2E run from this sandbox — verified from real CI instead.** The browser's
  request to Supabase came back as a 403 policy denial at this session's outbound proxy (confirmed via
  the proxy's own status endpoint — a real egress policy decision, not a flaky timeout to chase).
  Vitest and `npm run build` don't hit this because nothing in them makes a real network call; this was
  the first thing in this project's test suite that does. Pushed anyway and checked the PR's actual
  GitHub Actions run, which passed — confirming the harness genuinely reaches Supabase and cleans up
  after itself outside this sandbox
- **First real run surfaced a genuine timing issue, not a harness bug.** The scenario failed once
  (`.bubble.mine` not found within the default 5s) then passed on Playwright's automatic retry a few
  seconds later. Root cause: `send()` in `SessionView.vue` doesn't render a sent message optimistically
  — it only inserts into `session_log`, and the bubble appears once Supabase Realtime echoes the INSERT
  back through `subscribeMessages`. On a freshly-opened Realtime channel (this is the first message
  sent in that browser instance), that round trip occasionally runs past 5s. Fixed by giving that one
  assertion a 15s timeout instead of leaning on the retry to hide it — a retry that happens to pass
  isn't the same as a test that reliably captures the real latency it's asserting on

### v0.9.0 — 2026-08-30 (Stage E, part 1: schema renames)
- **Renamed:** `session_access.owner_pub` → `owner_tag` (it's a one-way derived lookup tag, never a
  real public key — the old name actively implied a property it doesn't have) and `messages` →
  `session_log` (Stage E will add non-message entry kinds — renames, capability grants — to this
  table; still message-only for now). Pure rename, no behavior change, no new columns
- **Requires a Supabase migration run in lockstep with the merge** — Preview and Production share one
  database, so running the SQL early (while this PR is still just in review) would break the live
  production app immediately, since unrelated code on `main` still expects the old names. Run the
  migration right when merging, not before
- First piece of Stage E's admin/capability layer (see `docs/system-design.md` §3) — the rest
  (per-session admin keys, per-identity signing keys, capability derivation, guarded invite) follow
  in their own PRs

### v0.8.0 — 2026-08-29 (message history pagination)
- **Added:** `SessionView.vue` used to fetch every `messages` row for a session on open, decrypting
  and rendering the entire history no matter its age — fine for a young session, a cost that only
  grows for an old one. `fetchMessagesInRange(sessionId, sinceISO, beforeISO)`
  (`src/api/sessions.ts`) now loads a `MESSAGE_PAGE_DAYS`-wide window (7 days) at a time, using the
  same plaintext `created_at` column the latest-activity sort already reads. A **Load more** button
  at the top of the thread shifts the window back another 7 days on tap, prepending the older batch
  and adjusting `scrollTop` by exactly the height that batch added, so the messages already on screen
  don't visibly jump
- **Considered and rejected:** showing "Load more" optimistically (always render it, treat an empty
  fetch as "no more") instead of a real existence check. It saves one indexed query per load, but
  costs an occasional dead tap right at the start of a session's history — not worth it when the
  check itself is a `select id ... limit 1`, as cheap as an existence check gets.  `hasMessagesBefore`
  runs once after the initial load and once after each load-more instead
- See "Message history loads a window at a time" in `docs/system-design.md` §3

### v0.7.0 — 2026-08-29 (Stage D: multi-participant invites)
- **Rejected, before building anything:** an "invite by username" design that resolved a typed
  username to a public key server-side. Caught in review: the resolution query is itself an
  observable event, correlatable by timing to whatever the inviter does immediately afterward — a
  live traffic observer (not even a database dump) could link "X looked up Y" to "X wrote
  something," no matter how anonymous the row written afterward looks. Every other join path in this
  app avoids this by construction (a link or private key is a secret both sides already hold, with
  nothing to resolve); this was the one design that would have introduced a resolve-then-act step
- **Added:** `session_invites` instead — the inviter already has the invitee's public key, obtained
  physically/out of band (`AccountHome.vue`'s "My public key" reveals a copyable blob for exactly
  this). `derivePairwiseSecret`/`derivePairwiseTag`/`derivePairwiseKey` (`src/lib/crypto.ts`) exploit
  ECDH's symmetry — `ECDH(A_priv, B_pub) === ECDH(B_priv, A_pub)` — so both sides independently
  derive an identical secret with no ephemeral keypair and no lookup; `checkForInvites`
  (`src/api/inviteActions.ts`) tries every other account's public key from `accounts` and finds a
  match with one indexed query, never a full scan. A database dump sees only opaque
  `{tag, ciphertext}` rows — computing a matching tag needs one of the two private keys.
  `generateKeyPair`/`importPrivateKey` gained `deriveBits` usage alongside the existing `deriveKey`
  for this. Verified with a standalone script (8 checks) before wiring in: DH reciprocity, a full
  round trip, a non-matching third party's candidate check correctly fails, an uninvolved party can't
  reproduce the tag or decrypt without either private key
- **Added:** accepting an invite is exactly `joinExistingSession` — an invite only ever needed to
  deliver a `JoinPayload` privately, so no new join logic exists. Rejecting/canceling is a plain
  delete, left client-checked (see "Deletion is client-checked only" in `docs/system-design.md` §3
  for why that's an accepted, pre-existing gap every table already has, not a new one)
- **Changed:** session list now sorts by latest-message time (`fetchLatestMessageTimes`,
  `src/api/sessions.ts`, reading plaintext `messages.created_at`) instead of the originally-planned
  grouped-by-participant view; pin/favorite deferred to Stage E
- **Dropped:** the originally-planned `accepted` flag / view-only enforcement for a newly-invited
  participant — it only existed to gate consent for being added without acting, and once invites are
  never delivered without an explicit accept step, every real join path already requires the
  affirmative action that consent needs
- **Designed but explicitly not built this phase** (see `docs/TODO.md`'s "Code" section for the full
  writeup): an admin/capability model where a session's admin rights are a second, distinct private
  key rather than a server-checked flag — forged claims are simply inert, since they can't hand
  anyone a real key, which eliminates the need for an RLS lock-down or Edge Function specifically for
  capability verification. Revocation isn't solved by this (admin-forever, deliberately, for now).
  Also considered and rejected as disproportionate for this app's scale: anchoring a hash-chained
  history on an external blockchain for tamper evidence — the cheaper, sufficient version is
  participants cross-checking a hash with each other directly, no external chain needed
- **Added:** a "Log in" option on the logged-out home (`SessionHome.vue`) — there was previously no
  direct way to sign back into an account without routing through an unrelated flow (joining,
  migrating). `extractAccountKey` (`src/lib/route.ts`) accepts a full account link on any origin
  (a preview deploy or production) or just the bare packed key, falling back to treating the whole
  trimmed input as the key when it doesn't parse as a route
- **Fixed a real regression, found through live device testing of the above:** pasting a real
  account link failed with `DataError: Data provided to an operation does not meet requirements`.
  Root cause: adding `deriveBits` usage to `generateKeyPair` for the invite mechanism meant
  `importPrivateKey` started requesting `['deriveKey', 'deriveBits']` on every import, but WebCrypto's
  JWK import rejects a request for any usage not already listed in the JWK's own `key_ops` — and
  every key exported before this branch has `key_ops: ['deriveKey']` only. This broke *every*
  pre-existing identity, not just accounts: guest personal links and the "log in and migrate/join"
  flows all import through the same function. Fixed by stripping `key_ops` before importing — it's
  bookkeeping this app itself attached at export time, not a real cryptographic restriction, so it's
  safe to drop and let the current usage list apply regardless of when the key was created. Verified
  with a standalone script reproducing the exact failure against an old-style JWK, confirming the
  fix succeeds where the pre-fix import throws the identical error
- **Added, after live testing surfaced the gap:** the invite-sent confirmation now names the
  recipient ("Invite sent to ava," resolved from the exact key just pasted — no new leak, since the
  inviter already holds it) and "Cancel it" was renamed "Undo," since that's what it actually is: it
  only works while the invite is still held in the inviter's own memory from just having sent it, not
  a real, always-available cancel (the row has no owner reference for a later visit to reconstruct).
  A persistent local list of sent invites was considered and explicitly rejected — undo-in-memory is
  the honest scope, matching what the design can actually support
- **Added:** "Adopt guest account" (`adoptGuestIdentity`, `src/api/sessionActions.ts`) — the mirror
  of "+ Add to account" from the other side: paste a guest identity's private key to recognize it as
  you, wherever it appears. First built as a `SessionView.vue` per-session control, then generalized
  to a fully account-level action on `AccountHome.vue`'s **Account** menu once it became clear it
  didn't need to be session-scoped at all — a guest identity holds exactly one `session_access` row
  by construction, so `adoptGuestIdentity` derives its lookup tag and opens that one row itself to
  learn which session and key to merge, rather than requiring the caller to already be viewing it.
  Same `migrateGuestSessionToAccount` call underneath either way. Paired with a per-session "Logged
  in as `<username>`" control on `SessionView.vue` showing which senders in *that* session are
  adopted aliases — deliberately scoped to the currently-open session rather than a global,
  cross-session list, after working through why a global version would need its own new,
  distinguishable fetch (see `docs/system-design.md` §3's "Why there's no account-wide list of my
  aliases")
- **UI pass, after live testing:** every panel that used to expand inline (Invite, invite-by-key,
  session aliases, my public key, adopt guest account) now opens in `Modal.vue`, a small reusable
  bottom-sheet/centered overlay. "Invite" collapsed from two separate top-bar buttons into one
  "Invite ▾" menu offering "By join link"/"By public key". Top-bar buttons that aren't the main
  action on a screen (Home, Log out, Account, Invite) got a ghost (outline, no fill) style instead of
  the solid `.chip` used everywhere else, to visually de-emphasize navigation/menu triggers relative
  to the actual content
- **Documented, not fixed — a real, distinct gap surfaced through review:** this schema hides the
  membership graph from anyone with only database *content* access, but does nothing about
  network/IP-level traffic correlation — an operator or network observer can still see "this IP
  repeatedly touches this stable tag," and one moment of IP-to-identity linkage (a signup, an ISP
  log) connects backwards to everything that IP/tag ever touched. VPN/Tor is the real mitigation,
  and it's the user's choice to make, not something this app provides
- **Fixed a real bug, found through live device testing of the menu UI pass above:** SessionView's
  Invite ▾ menu opened and showed both options, but tapping either one did nothing — no modal
  appeared. AccountHome's near-identical Account ▾ menu worked. The two had each hand-rolled their
  own open/close state and their own document-level outside-click listener scoped to a large shared
  wrapper (`panelArea`/`accountMenuArea` — the same wrapper other, unrelated panels used for their
  own outside-click handling), so the two menus weren't actually running the same code, just
  similar-looking code, and only one of the two copies happened to work reliably. Root-caused to
  exactly that duplication rather than to any specific mobile Safari quirk. Fixed by extracting
  `MenuButton.vue` — a single component that owns its own open state, does outside-click detection
  against its own root element only (never a page-wide wrapper), and exposes each option a
  `select(action)` via scoped slot that closes the popover and runs the action together, always in
  that order. Both menus now use it; there's exactly one implementation of "menu button" behavior to
  get right instead of two
- **Root-caused the Invite ▾ menu bug via on-device logs, after static reasoning didn't find it:**
  tapping a menu option opened its modal correctly, then a *second*, separate click event fired a
  moment later, was seen by `SessionView`'s outside-click handler as landing outside `panelArea`, and
  closed everything the first click had just opened — all fast enough to look like tapping did
  nothing. This is a known mobile Safari behavior: when the tapped element is removed from the DOM as
  part of handling its own click (here, the menu item disappearing as `MenuButton` closes its
  popover), the browser can synthesize a trailing `click` afterward, retargeted to whatever's now
  under that point — in this case, off `panelArea` entirely. Fixed with `useOutsideClick`
  (`src/lib/useOutsideClick.ts`): an outside click only counts if its `mousedown` *also* started
  outside, since a ghost click has no mousedown of its own — the real one already fired against the
  original element before anything was removed. `MenuButton` and `SessionView`'s panel-closing both
  use it now instead of a bare `document` `click` listener
- **Restyled:** the ghost tag buttons (Home, Log out, Account ▾, Invite ▾) were rendering with much
  more padding/height than their small font size implied — closer to the solid `.chip` buttons'
  footprint than a genuinely small tag/pill. Shrunk padding and min-height and switched to a fully
  rounded pill shape, matching the tight, thin-border, small-text style of a reference app's tab/toggle
  pills the user pointed to
- See "Session list sorted by latest activity," "Adding an existing account to a session by
  public key," and "'Adopt guest account' is the mirror of '+ Add to account'" in
  `docs/system-design.md` §3 for the full design

### v0.6.0 — 2026-08-28 (Stage C: guest → account migration)
- **Added:** `migrateGuestSessionToAccount` (`src/api/sessionActions.ts`) — adds an account's own
  `session_access` row to a session it currently only holds as a guest, plus a new
  `session_participants` row for the account's real key; the guest's original row is never touched
- **Fixed (found in live device testing, 3-tab scenario):** an account that had already joined a
  session *directly* under its own key, then separately used "+ Add to account" to migrate in a
  *different* guest identity that also participated in the same session, never actually recognized
  that guest's old messages as its own. Root cause: `migrateGuestSessionToAccount`'s idempotency guard
  (`alreadyHasAccess`) treated "the account already has *some* row for this session" as "this guest
  identity is already migrated," and returned early without ever writing the pin — so the guest's key
  was never added anywhere the account's client could learn about it. Fixed by replacing the single
  `identityPublicKeyId` field with an `identityPublicKeyIds` array, merged into whatever access row
  the account already has for that session (updated in place via a new `updateSessionAccess`) instead
  of always inserting a fresh row and gating on a too-coarse existence check. Also added
  `isIdentityMerged` (checks whether *this specific* guest key is in the array, for the "+ Add to
  account"/Warning visibility check — narrower than `alreadyHasAccess`, which is still correct for its
  original use, preventing an account from double-joining under its own key) and a `hasParticipant`
  guard so migrating never inserts a duplicate `session_participants` row when the account already has
  one from a direct join. Verified with a standalone script reproducing the exact reported scenario:
  after migration the account still has exactly one `session_access` row (merged, not duplicated), its
  `myKeys` set includes both its own key and the merged guest key, and participant rows stay at exactly
  one-per-identity. See "An account can migrate a guest session it already holds" in
  `docs/system-design.md` §3
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
