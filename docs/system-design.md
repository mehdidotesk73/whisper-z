# System Design — Architecture & Patterns

Developer-facing documentation of how the app is structured, how data flows, and design decisions.

## §1 — System Overview

This is a Vue 3 + TypeScript + Vite single-page app (SPA) that works as a progressive web app (PWA). It provides:

- **Header/footer shell** — app title, Help modal, build/version info, reload affordance, debug panel
- **Service-worker caching** — offline capability, smart update detection
- **Mobile-first UX** — responsive, touch-optimized, no hover-only interactions
- **Five screens** (`src/components/SessionHome.vue`, `AccountHome.vue`, `CreateAccount.vue`,
  `JoinSession.vue`, `SessionView.vue`), switched by a hash-based router (`src/lib/route.ts`) — no
  `vue-router`, just enough parsing for five link shapes
- **Pure computation layer** (`src/lib/`) — key agreement, sealed envelopes, encrypt/decrypt,
  routing, clipboard
- **Data layer** (`src/api/`) — the Supabase client and opaque-record reads/writes/realtime
  subscriptions (the database never sees plaintext identity or membership relationships — see §3)
- **Hot reload in dev** — instant feedback on code changes
- **Netlify** — production site and a live preview on every branch/PR, one host
- **Supabase** — stores only encrypted, opaque records; see §3 for the full model

### Architecture Diagram

```
┌─────────────────────────────────────────┐
│           Browser (PWA)                 │
│  ┌───────────────────────────────────┐  │
│  │  Service Worker (cache, updates)  │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  App.vue (header/footer shell)    │  │
│  │  ├─ HelpModal                     │  │
│  │  ├─ DebugPanel                    │  │
│  │  ├─ UpdateAvailablePrompt         │  │
│  │  └─ route.ts picks one of:        │  │
│  │   SessionHome│AccountHome│        │  │
│  │   CreateAccount│JoinSession│      │  │
│  │   SessionView                     │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  lib/ (pure functions)            │  │
│  │  ├─ crypto.ts (ECDH + AES-GCM,    │  │
│  │  │   sealed envelopes, lookup     │  │
│  │  │   tags — see §3)               │  │
│  │  ├─ route.ts (hash router)        │  │
│  │  ├─ guestName.ts                  │  │
│  │  └─ clipboard.ts                  │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  api/ (Supabase data access)      │  │
│  │  ├─ supabase.ts (client)          │  │
│  │  ├─ sessions.ts (opaque reads/    │  │
│  │  │   writes/realtime — the client │  │
│  │  │   decrypts, the API doesn't)   │  │
│  │  ├─ accounts.ts (username ↔       │  │
│  │  │   public key — the one         │  │
│  │  │   intentionally searchable     │  │
│  │  │   identity kind)               │  │
│  │  ├─ sessionActions.ts (shared     │  │
│  │  │   start/join, account-aware)   │  │
│  │  └─ sessionList.ts (decrypts an   │  │
│  │      account's own session_access │  │
│  │      rows into a chat list)       │  │
│  └───────────────────────────────────┘  │
└──────────────────┬──────────────────────┘
                    │ nothing but ciphertext and
                    │ purpose-derived lookup tags
                    ▼
┌─────────────────────────────────────────┐
│   Supabase (Postgres + Realtime)        │
│   opaque tables only — see §3           │
└─────────────────────────────────────────┘
```

## §2 — Header/Footer Wrapper Template

This is the shell that wraps every page/tab. It provides version checking, update affordances, Help modal, and debug logging. See `src/App.vue` for the full implementation.

### Key Features

1. **Header** — app title (centered), Help button (top-right), "Update available" button (top-left when new version detected)
2. **Footer** — build ID/timestamp (clickable to expand debug log), "Reload latest" button, version status
3. **Debug panel** — collapsible log of on-screen messages (no console on mobile)
4. **Help modal** — renders markdown docs from `docs/concepts/*.md`
5. **Update detection** — background check against live origin, prompts user when new build is available

### Version Checking Logic

- On load, `useVersionCheck()` compares the loaded build ID against what's live at the origin
- States: "current" (up to date), "update-ready" (new build is live), "checking" (in progress)
- "Reload latest" button: checks again, then reloads if a new version exists
- Service worker auto-updates in the background; the version check surfaces this to the user

### Styling

Uses CSS custom properties (`--bg-elev`, `--text`, `--border`, etc.) for theming. Dark/light mode via `prefers-color-scheme` media query. Mobile-safe padding with `safe-area-inset` for notch/bottom-bar devices.

## §3 — Session Data Model & Trust Model

**Design principle:** the database stores only opaque, encrypted records. It never holds a
plaintext relationship saying which identity belongs to which session — only ciphertext, and a
lookup value derived from a private key that the database itself cannot invert. See
`docs/experience.md` for the full design rationale and what was considered and rejected along the
way (a capability-signature/permission system, a dedicated verification server) — those are future
work, not part of this model.

```sql
sessions (id uuid pk, created_at)                          -- an opaque container, nothing else

session_access (                                            -- "who can find this session, with what key"
  id uuid pk, owner_tag text, ciphertext text, iv text,
  ephemeral_public_key text, created_at
)

join_access (                                                -- a redeemable invite link
  id uuid pk, ciphertext text, iv text, created_at, consumed_at nullable
)

session_participants (                       -- who's in a session — session_id plaintext, identity encrypted
  id uuid pk, session_id fk → sessions, ciphertext text, iv text, created_at
)

session_log (                              -- renamed from `messages`; still message-only until Stage E
  id uuid pk, session_id fk → sessions, ciphertext text, iv text, created_at
)

accounts (                                                    -- a stable, intentionally searchable identity
  id uuid pk, username text unique, public_key text unique, created_at
)

session_invites (                        -- Stage D: add an account by a public key exchanged out of band
  id uuid pk, tag text, ciphertext text, iv text, created_at
)

private_account_state (                                       -- reserved, not yet used by any shipped feature
  id uuid pk, owner_tag text, ciphertext text, iv text,
  ephemeral_public_key text, created_at
)
```

**What each `ciphertext` actually decrypts to.** The schema above shows column names, not payload
shapes — a plaintext column tells you what's *stored*, but every meaningful field in this app lives
inside a ciphertext blob, and that shape is exactly as much a part of the design as the columns are.
Every payload type below lives in `src/lib/sessionTypes.ts` unless noted otherwise.

| Table | Looked up by | Encrypted with | Decrypts to | Notes |
|---|---|---|---|---|
| `session_access` | `owner_tag` (a derived lookup tag, not a real public key) | ECIES sealed to the row's owner — `sealForRecipient`/`openSealed`, using the row's own `ephemeral_public_key` | `SessionAccessPayload { sessionId, sessionKey, role: 'owner' \| 'member', title?, identityPublicKeyIds? }` | `sessionKey` (a JWK) is the actual credential this row exists to deliver — everything else is metadata about it. `title` is declared but nothing writes it yet (see below). `identityPublicKeyIds` is a private hint only the account itself can read — see "An account can migrate a guest session it already holds" |
| `join_access` | `id` (the row's own uuid, carried directly in the join link) | A raw AES-256 key carried in the link's URL fragment (`generateJoinSecret`/`importJoinKey`) — no key agreement, no persistent identity on either end | `JoinPayload { sessionId, sessionKey }` | Same payload shape as `session_invites` below; the two differ only in *how the reader gets the key*, not in what the key unlocks |
| `session_invites` | `tag` (a pairwise-derived value, independently computable by inviter and invitee only) | Pairwise ECDH secret between the inviter's and invitee's real keypairs (`derivePairwiseKey`) | `JoinPayload { sessionId, sessionKey }` | `tag` itself is `derivePairwiseTag` of that same shared secret — see "Pairwise discoverable secrets" in `lib/crypto.ts` |
| `session_participants` | `session_id` (plaintext) | The session's own shared AES-256 key — symmetric, the same key `session_log` uses, no key agreement needed since holding the session key already proves membership | a bare string — just the participant's canonical public key id, **not** a JSON object | One row per identity that's ever sent a message under that key. No display name and no role live here; a name is resolved live per-message (see `session_log` below), and role lives on each viewer's own `session_access` row instead |
| `session_log` | `session_id` (plaintext) | The session's own shared AES-256 key | `DecodedMessage { sender, text, createdAt }` | `sender` is a public key id — resolved to a display name live at render time (an `accounts` lookup, falling back to a deterministic guest name), never stored as a name anywhere |
| `private_account_state` | `owner_tag`, same scheme as `session_access` | ECIES sealed, same as `session_access` | *(no payload type exists yet — reserved for a future feature, not written by anything shipped)* | |
| `accounts` | `username` or `public_key`, both plaintext | Not encrypted at all | n/a | The one table with intentionally plaintext, searchable columns — see "account is just another identity" below |
| `sessions` | `id` | Not encrypted at all | n/a | Literally just an id and a timestamp — an opaque container row, nothing else in it |

**One shared key per session, not a key per pair.** Whoever starts a session generates a single
random AES-256 key (`generateSessionKey`) — never derived from anyone's identity keypair. Every
message in that session is encrypted with it. This is what makes adding participants later (a
planned feature) require no re-encryption of history: a new participant just needs their own sealed
copy of the same key, not a whole new scheme.

**Sealed envelopes (ECIES), the one encryption pattern reused everywhere.** `sealForRecipient`
generates a one-time keypair, does ECDH between its private half and the recipient's public key,
and uses the resulting shared secret to AES-GCM-encrypt the payload — storing the ciphertext, iv,
and the one-time keypair's *public* half (its private half is discarded immediately). `openSealed`
reverses it: ECDH between the recipient's real private key and that stored ephemeral public key
recovers the same shared secret. Every encrypted table in this schema — `session_access` now,
`private_account_state` later — uses this same pair of functions in `src/lib/crypto.ts`. Nothing
here is a new algorithm, just ECDH + AES-GCM applied to a one-time keypair instead of a long-term
identity.

**Why `session_access.owner_tag` isn't a real public key.** An account's actual public key is
already public information (`accounts.public_key`, intentionally searchable) — using it directly as
the lookup column for "which sessions does this identity have" would let anyone who already knows
that public key run exactly that query and reconstruct the membership graph. Instead, `owner_tag` is
`deriveLookupTag(privateKey, 'session-access')`: a
SHA-256 digest of the private key's scalar plus a purpose string. It's stable (the same identity
always re-derives the same tag, so one query finds every session_access row it owns), but
computable *only* by whoever holds the private key — the public key alone gives no way to compute
it. This closes the correlation gap with nothing more exotic than a hash.

**A personal link needs only a private key.** An EC private key's JWK export already contains its
public half (`x`, `y`) alongside the private scalar (`d`) — `publicJwkFromPrivateJwk` just strips
`d`. So a personal link (`#/session/<packedKey>`) carries nothing but the private key: the client
derives the public key, the lookup tag, queries `session_access` for that tag, and decrypts
whichever row comes back to learn the session id and the shared key. No session id, no role, no
separate identifier needed in the URL at all.

**Join links are a symmetric bearer secret, not tied to any identity — single-use and short-lived.**
Tapping Invite generates 32 random bytes (`generateJoinSecret`) used directly as a raw AES-256 key —
no key agreement, since there's no recipient identity yet to agree with. The `join_access` row's
ciphertext (session id + session key) is encrypted with those bytes; the link
(`#/join/<joinId>/<secret>`) carries a plain lookup id (safe — it's not secret on its own) and the
secret in the fragment. Redeeming it (`claimJoinAccess`) is a single `UPDATE ... WHERE consumed_at
IS NULL RETURNING` statement, not a read followed by a separate write — Postgres only lets one of
any number of concurrent callers actually see `consumed_at IS NULL` still true and win, so if two
people click "Join" on the same link at once, exactly one gets the row back and the other gets
`null`. That's what makes this genuinely single-use rather than best-effort. The row is marked
consumed rather than deleted specifically so a later visit can tell "already used" apart from
"never existed" — `fetchJoinAccess` (the read-only check that runs when the link is first opened,
before anyone has clicked "Join") looks at `consumed_at` for that message; merely opening a link,
used or not, never mutates anything, so it can't itself grant access. It also expires:
`isJoinAccessExpired` compares `created_at` against a 10-minute TTL (`JOIN_LINK_TTL_MS`), checked
both on open and again at the atomic claim, so a link that goes stale between opening and clicking
"Join" still can't be redeemed — attempting to claim an expired link consumes it on the spot, so no
cron job is needed to close that window. Inviting a second person means generating a second link
(the Invite panel's "New link, for another person"). Any participant, not just the session's owner,
can currently mint an invite link — restricting that to the owner is one of the still-open gaps
tracked in `docs/TODO.md`, alongside real (server-verified) role enforcement.

**`session_participants` is keyed by plaintext `session_id`, but each row's identity is encrypted —
this was a real vulnerability until it wasn't.** An earlier version of this table stored a
participant's public key as a plaintext column. That looked harmless — every legitimate participant
already sees who else is in a *specific, already-known* session by definition of being in the
conversation — but it quietly reopened exactly the leak `session_access`'s lookup-tag design exists
to close: an account uses the *same real public key* every time it joins or starts a session, so a
plaintext `public_key` column, combined with RLS set to `using (true)`, let anyone with database
access run `select session_id from session_participants where public_key = X` directly and
reconstruct the complete list of sessions that account has ever touched — the membership graph,
recovered through a side door. Guests were never exposed this way (a one-off keypair isn't linkable
to anything else), but any account participating normally was.

The fix reuses a pattern already in the schema rather than inventing one: each row's identity is now
symmetrically encrypted with that *session's own shared key* — the exact same key and the exact same
`encryptText`/`decryptText` functions `session_log` already use. No ECDH, no `ephemeral_public_key`
column needed here, because this isn't sealed to one specific recipient — anyone who legitimately
holds the session key (i.e., is already a real participant, via their own `session_access` row) can
decrypt every row for that session. `session_id` stays a plaintext lookup column — "this session has
N participant rows" is the same class of accepted metadata leak as `messages.session_id` already
being plaintext (existence and rough activity level, never identity) — but a raw database dump can no
longer be searched by public key at all. Joining still costs one insert of your own new row,
encrypted with a key you already have in hand at that point; nobody else's row is ever rewritten. See
"a message's displayed sender name is resolved live" below for how both the thread and the chat-list
"other participants" preview turn a decrypted public key into a name, identically, on demand — no
name is ever stored here, encrypted or otherwise.

**An account is just another identity — the same mechanism, a stable keypair.** Creating an account
(`CreateAccount.vue`) generates a keypair exactly like a guest does, except the keypair is kept (a
packed private key in `localStorage`, plus an `#/account/<packedKey>` link for another device) and
reused as-is for every session the account touches, instead of a fresh one per session. It calls
`deriveLookupTag(accountPrivateKey, 'session-access')` — the *same* function, the *same* purpose
string — so `session_access` doesn't need to know or care whether a row's owner is a guest or an
account. The one difference this stability buys: because the tag never changes, one query
(`fetchSessionAccessForOwner`) returns every `session_access` row the account has ever been sealed
into, which `src/api/sessionList.ts` decrypts into a chat list. `accounts.public_key` is the one
identity value in this schema that's deliberately plaintext and searchable — that's what lets
someone start a session targeted at an account by its username-resolved public key, and what lets a
chat list resolve a fellow participant's current username. It is never used as `session_access`'s
lookup column; that stays the private-key-derived tag, so a database dump still can't connect an
account to the sessions it holds.

**An account's stable keypair means re-opening an invite it's already used must not re-join.** A
guest identity is fresh every visit, so "have I already joined this session?" is never a question
for one — but an account reuses the same keypair everywhere, so without a check, an account
re-opening an invite link it already redeemed (its own, most commonly, since the owner is the one
holding the link right after creating it) would seal and insert a *second* `session_access` row and
a duplicate `session_participants` row on every visit. `joinExistingSession`
(`src/api/sessionActions.ts`) guards this: before doing anything else, it decrypts the account's own
`session_access` rows (the same query `sessionList.ts` uses) looking for one whose `sessionId`
already matches, and if it finds one, returns that session id directly instead of creating anything
— the caller just navigates there, same as a normal join. A guest never runs this check (there's
nothing to find), so this only ever short-circuits an account.

**An invite link offers all three ways to redeem it, decided in the UI, not the data.** `JoinSession.vue`
shows `Join as <username>` when `currentAccount` is already set, `Join as guest` /
`Join as existing user` otherwise — "existing user" just calls `loginWithPackedKey` on a pasted
account link and then calls the same `join()` used everywhere else. Nothing about the join link or
the join payload encodes which path was taken; it's purely which identity happens to be active in
the browser when "Join" is actually clicked. This is the same "one session system, different ways
to access it" principle the whole account/guest split is built on.

**Why a personal link isn't enough once an account exists: the `mysession` route.** A bare private
key resolves to "whichever `session_access` row that tag has" — fine when there's exactly one, which
is true for every guest identity by construction (a fresh keypair per session). An account's tag can
have many. So opening a session from a chat list uses `#/mysession/<sessionId>` instead of
`#/session/<packedKey>`: `SessionView` uses the *logged-in account's* keypair to fetch every row
under its tag, then opens each envelope until it finds the one whose decrypted `sessionId` matches
the route — the id in the URL is just a disambiguator, never a capability, since it's meaningless
without the account's private key to actually open anything. This is also the flag that turns off
the **Warning** control: an account-backed session is always recoverable via the account's own link,
so there is nothing to warn about losing — and the same reasoning turns it off for a migrated guest
session too, checked at mount (for a `packedKey` route) via `isIdentityMerged` — specifically whether
*this* guest identity has been merged into the current account, not just whether the account has
some unrelated access to the session (see "An account can migrate a guest session" below for why
that distinction matters).

**An account can migrate a guest session it already holds — and starts sending as itself from that
point on.** A message's `sender` field is baked into its ciphertext at send time, immutably, so
"attach my guest session to my account" can never rewrite who sent old messages — only add a new way
to reach the session and a new identity to send under going forward. `migrateGuestSessionToAccount`
(`src/api/sessionActions.ts`) merges the guest's public key into `identityPublicKeyIds`, an array on
the account's own `session_access` row for that session (sealed to the account's real key as always,
so only the account can find it via its own lookup tag). Merges, not just pins a single key, because
an account can end up needing to recognize *more than one* prior identity in the same session — most
notably, an account that already joined this exact session directly under its own key (`ava` in the
scenario below) before ever migrating a guest visit in. If the account has no row for this session
yet, one is created with a single-entry array; if it already has one — from a direct join or an
earlier migration of a *different* guest identity in the same session — that row is updated in place,
adding the new key to the array, rather than inserting a second row for the same session. A second
row was tried first and found to be a real bug (see `docs/experience.md`'s v0.6.0 entry): `SessionView`
finds "the" row for a route's `sessionId` by taking the first match it opens, so a second row's pin
silently never gets read — an account that had directly joined a session and then migrated a guest
identity into it saw the guest's old messages rendered as a stranger's forever, never as its own. A
`session_participants` row for the account's real key is added only if one doesn't already exist
(skipped when the account already joined this session directly, so its own key never gets a duplicate
row). Nobody else's client ever reads `identityPublicKeyIds` — a fellow participant has no basis to
connect the merged identities, and isn't meant to. From migration onward, `SessionView.vue` sends new
messages under the account's real key (`ownPublicKeyId`), which is what lets those messages resolve to
the account's actual username for everyone — see "a message's displayed sender name is resolved live"
below. The guest's original personal link, and its untouched `session_participants` row, keep working
afterward too — migration only *adds*, never rewrites. Idempotent per guest identity: re-migrating the
same guest key just confirms it's already in the array, without touching the row again.

**A message's displayed sender name is resolved live, purely from `sender` — never baked in, never
read from `session_participants`.** A decrypted message is `{ sender: <public key id>, text,
createdAt }` (`src/lib/sessionTypes.ts`) — that's all it carries. `SessionView.vue`'s `nameFor`
resolves a name for any key the same way, every time it's asked: look it up in `accounts`
(`fetchAccountByPublicKey`); if that key isn't anyone's account, fall back to
`guestNameForKey(publicKeyId)` (`src/lib/guestName.ts`) — a small non-cryptographic hash of the key
itself picking a color+noun+suffix combination. Nothing is stored for the fallback case either: the
same key always hashes to the same name, computed identically by every viewer, with no lookup and no
write. Resolution is memoized per key in a `reactive()` map (`resolveName`) so the async accounts
query only happens once per distinct sender seen, with the deterministic name shown instantly as a
placeholder in the meantime — no "Someone" flash while it resolves.

This is what makes a migrated identity behave correctly *without treating it specially anywhere*:
`migrateGuestSessionToAccount` (see above) leaves the guest's old messages exactly as they were —
sealed under the guest's original key, which was never anyone's `accounts` row, so they always
resolve to that one deterministic guest name, forever. From migration onward `SessionView.vue` sends
new messages under the account's real key (`ownPublicKeyId`), not any pinned one —
`identityPublicKeyIds` is consulted for exactly one purpose, privately, on the account's own client:
extending its local `myKeys` set so old messages under every merged identity *still* count as "mine"
for bubble alignment. Nobody else's `nameFor` call ever looks at `identityPublicKeyIds` — a fellow
participant has no way to connect the merged identities, and isn't meant to; only the account itself
privately knows they're the same. A message sent by an account always resolves to that account's
*current* username, including retroactively if it's renamed later (there's no rename feature yet,
but nothing here would need to change if one shipped) — this is a deliberate choice of "always show
the truth now" over "freeze what was true when it was sent," and it costs nothing extra: the accounts
table was always the source of truth for what an account is called.

`session_participants` still exists and still matters — not for names, but as the enumeration
`sessionList.ts` needs to know who's "in" a session without decrypting every message in it. It has
never stored a name — only an encrypted public key (see "`session_participants` is keyed by
plaintext `session_id`" above) — so displayed names anywhere in the app — the thread, and a
chat-list "other participants" preview — are always computed the same way, from a public key, on
demand.

A resolved name (an account's own username, unbounded in length) is truncated to 20 characters with
a trailing `…` wherever the thread renders it (`truncateName`, `lib/guestName.ts`) — display-only,
never affecting the stored value or the identity itself.

**No "waiting for the other side" state anymore.** Because the session key isn't derived from a
second person's public key, the creator has full read/write access to their own session the instant
they create it — `SessionView` opens straight into the thread, with an **Invite** control that
reveals a join link on demand and a **Warning** control (shown whenever the current identity has no
account to fall back on) explaining that closing the tab without saving the personal link means
permanent loss of access.

**Session list sorted by latest activity, not grouped by participant.** `fetchLatestMessageTimes`
(`src/api/sessions.ts`) reads `messages.created_at` — already plaintext, the same existence/timing
metadata the schema has always exposed — for every session in an account's list, and
`fetchSessionList` sorts descending by that. A session with no messages yet sinks to the bottom.
Superseded an earlier plan to group the list by other participant, in favor of something closer to
how every real chat app behaves; pin/favorite is deferred to a later UX-polish phase.

**Adding an existing account to a session by public key — Stage D's `session_invites`, and why it
isn't a username lookup.** An early design let an inviter type someone's username and resolve it to
a public key server-side. That was rejected: resolving an identifier to a key is an *observable
event*, and it's tied by timing to whatever the inviter does immediately after — a live traffic
observer (not even a database dump) could correlate "X looked up Y" with "X wrote something," no
matter how anonymous the row that gets written looks. Every other join path in this app avoids this
entirely by construction (a link or a private key is a secret both sides already hold, with nothing
to resolve) — a lookup-based invite is the one thing that would have introduced a resolve-then-act
step, so it was dropped rather than patched.

The shipped design instead assumes the inviter already has the invitee's public key, obtained
**out of band** — physically, or however the two people already trust each other (`AccountHome.vue`'s
"My public key" reveals a copyable blob for exactly this). From there:

- ECDH is symmetric: `ECDH(inviter_priv, invitee_pub) === ECDH(invitee_priv, inviter_pub)` (this is
  the definition of Diffie-Hellman, not a new primitive) — `derivePairwiseSecret`
  (`src/lib/crypto.ts`) computes it via `deriveBits`, since (unlike every other use of ECDH in this
  app) two *different* purposes need to be derived from the same raw secret: a discoverable `tag`
  and a symmetric `key` (`derivePairwiseTag`/`derivePairwiseKey`, each hashing the secret with a
  distinct purpose string, the same namespacing idea as `deriveLookupTag`).
- The inviter seals a `JoinPayload` (`{sessionId, sessionKey}` — exactly what a link-based invite
  already carries) with the pairwise key, and writes `{tag, ciphertext, iv}` to `session_invites`
  (`createSessionInvite`, `src/api/inviteActions.ts`). No ephemeral keypair, unlike `session_access`
  — the secret is a stable pairwise value, so there's nothing to generate per invite.
- The invitee derives the identical tag from *their* side, tried against every other account in
  `accounts` (`checkForInvites`) — the one already-public directory in this schema — and finds a
  match with one indexed `where tag in (...)` query, never a table scan. A database dump sees only
  opaque `{tag, ciphertext}` rows: computing a matching tag requires one of the two private keys, so
  nothing is attributable to either party without one. Accepted residual leak: two invites between
  the same pair share an identical tag, since the secret is fixed per pair — reveals "these two rows
  are linked," never to whom, the same class of leak as everything else in this schema.
- Accepting an invite is exactly `joinExistingSession` — the invite only ever needed to deliver a
  `JoinPayload` privately; nothing about joining itself is new. Rejecting (invitee) or **undoing**
  (inviter — not "canceling": it only works while they still hold the row id in memory from just
  having sent it, gone on refresh, since the row has no owner reference for a later visit to
  reconstruct) is a delete, gated only by whichever side can derive the tag to begin with — see the
  note below on why that's not enforced any harder than that. The inviter's own client resolves and
  shows the recipient's username right after sending ("Invite sent to ava") by looking up the exact
  public key it just pasted — no new leak, since the inviter already holds that key itself.

**Deletion is client-checked only, same as every other write in this schema.** RLS can check row
contents and connection metadata, not a cryptographic proof — Postgres has no built-in way to verify
"does the caller hold the private key matching this row" the way `crypto.subtle.verify` could, so
`using (true)` (which every table already has, for every operation, not just this one) can't stop a
malicious client from deleting *any* row in *any* table today. This isn't a new gap `session_invites`
introduces; it's the same one every table has always had. Deleting a `session_invites` row can't
forge or read anything either way — worst case is losing an invite before it's seen, which can just
be re-sent — so it's an acceptable place to leave client-checked, consistent with the already-
documented "restricting invite-link minting to the owner" gap.

**"Adopt guest account" is the mirror of "+ Add to account," from the other side — and it's fully
account-level, not tied to any open session.** The original migration flow requires opening the
*guest's* personal link and clicking "+ Add to account" from there. `adoptGuestIdentity`
(`src/api/sessionActions.ts`), reachable from `AccountHome.vue`'s **Account** menu, does the same
`migrateGuestSessionToAccount` call, just triggered from the account's own home screen instead: paste
the guest identity's *private* key directly (the same key its Warning button reveals). It doesn't
need to already be viewing that session — a guest identity holds exactly one `session_access` row by
construction (a fresh keypair per visit), so `adoptGuestIdentity` derives the guest's own lookup tag,
opens that one row itself to learn which session and key it's for, and calls
`migrateGuestSessionToAccount` with those. No new mechanism — same merge, same non-destructive
semantics, just an entry point that works from anywhere. A separate "Logged in as `<username>`"
control on `SessionView.vue` (account-backed `sessionId` routes only) shows *that particular
session's* adopted aliases, resolved via `sessionAliasKeys`/`nameFor` state already loaded to render
the thread — no new fetch, per the same reasoning that ruled out a global, cross-session aliases view
(see below). Adopting is account-wide; seeing the effect is still naturally per-session.

**Why there's no account-wide "list of my aliases" page.** A global view would need its own fetch —
"give me every alias this account has ever adopted, across every session" — and that fetch would
itself be a new, distinguishable network event, exactly the kind of pattern this schema has
otherwise avoided (see the username-lookup rejection above). Each session's aliases already ride
inside that session's own `session_access` payload, which the account was going to decrypt anyway to
open the session — so surfacing them only *inside* an already-open session costs nothing extra,
while a cross-session aggregation would cost something new. Scope stays per-session on purpose.

**Honest limitation: this protects database *content*, not network-level traffic patterns.** Nothing
here stops a party with visibility into requests reaching the server — the hosting operator, or
anyone watching network traffic to it — from observing "this IP repeatedly fetches rows tagged with
this `owner_tag`" or "these two IPs both touch this session's rows," independent of anything being
encrypted. That correlation isn't nothing: `createAccount` sends a plaintext username at account
creation, and `fetchSessionAccessForOwner` is called with the *same stable* tag every time that
account checks its chat list — so a single moment where an IP is tied to a username (a signup
record, an ISP log, a coffee-shop WiFi sheet) can retroactively connect that IP's entire request
history back to everything its tag ever touched. This is a traffic-analysis problem, not a database
one, and the schema's design (hidden membership graph, no plaintext identity columns) does nothing to
address it — the only real mitigation is the user's own choice to connect through a VPN or Tor, which
changes what IP the server sees in the first place. Incognito/private browsing mode does not help
here: it only affects local browser storage, not what the server observes over the network.

**What the server can and can't see:** ciphertext is opaque, exactly as before. What's new here is
that the *membership graph itself* — which sessions a given identity/account touches — is opaque
too, not just message content. Metadata that remains visible: that a session exists, roughly when
messages were sent, how many `session_access` rows a given lookup tag has (existence/count, not
which sessions), and now also how many `session_invites` rows exist system-wide (count only, never
who they're between). There's still no out-of-band key verification and no forward secrecy — same
honest caveats as before, now joined by "an active database attacker with write access could still
tamper with a row in ways an honest client would reject, but nothing here stops that at the server;
see `docs/experience.md` for why that's deliberately out of scope for now."

**Message history loads a window at a time, not all at once.** `SessionView.vue` used to fetch every
`session_log` row for a session on open — fine for a young session, but a cost that only grows, paid on
every open, for one that's been running a long time. `fetchMessagesInRange(sessionId, sinceISO,
beforeISO)` (`src/api/sessions.ts`) fetches a `MESSAGE_PAGE_DAYS`-wide slice (7 days) using the same
plaintext `created_at` column the latest-activity sort already reads — no new metadata exposed, just a
narrower query. Opening a session loads `[now - 7d, now]`; a **Load more** button, shown at the top of
the thread, shifts the window back by another 7 days each time (`[start - 7d, start)`, tiling exactly
against the previous window with no gap or overlap since one edge is `gte` and the other `lt` on the
same boundary value). Older messages are prepended rather than appended, and the scroll position is
adjusted by exactly the height the prepended content added (`scrollTop += scrollHeightAfter -
scrollHeightBefore`), so what the user was already reading doesn't jump.

Whether to show **Load more** at all is decided by `hasMessagesBefore(sessionId, beforeISO)` — a
real existence check (`select id ... limit 1`), run once after the initial load and again after each
load-more, rather than assumed optimistically from whether the last fetch happened to fill a window.
An optimistic version (always show the button, let an empty fetch be the "no more" signal) was
considered and rejected: it trades one indexed existence check for an occasional dead tap at the very
start of a session's history, but a real check is cheap enough here that there's no reason to accept
the imprecision.

**Stage E: the admin/capability layer (in progress, built in slices).** Worked out over several
rounds of design review, including two rejected alternatives verified with standalone scripts before
being ruled out (see "Two rejected designs" below) — recorded here in full before any of it was coded.

**Slice 1, shipped:** the admin ECDH + signing keypair (generated at session creation, forwarded
through `SessionAccessPayload`/`JoinPayload`), every identity's derived personal signing keypair,
`session_participants`' payload gaining a `signingPublicKey`, and every new `session_log` message
being signed and verified — see "Signing Is Opportunistic, Not Yet Enforced" and "Deriving an ECDSA
Keypair From a Raw Scalar" in `docs/experience.md` for the transition-safety tradeoff and the one
open cross-browser risk this leaves. `migrateGuestSessionToAccount` (`src/api/sessionActions.ts`) was
also changed to take the guest's whole decrypted payload rather than a narrow parameter list, so a
migrating guest identity's admin keys (and, later, a title) ride along instead of being silently
dropped — a real gap the original narrower signature had.

**Slice 2, shipped:** `deriveCapability` (the same one-way primitive as `deriveLookupTag`, aliased —
see `lib/crypto.ts`), the full capability-grant flow (`grantCapability`/`acceptCapabilityGrant` in
`src/api/sessionActions.ts` — the two-layer seal and self-write-on-receipt described below, verified
end-to-end in `sessionActions.test.ts` without needing a live database), and gating invite-minting on
`hasCapability(payload, 'invite')`: the Invite menu is hidden entirely for a member who hasn't been
granted it, and `generateInvite`/`sendInviteByKey` both refuse defensively even if called some other
way. `SessionView.vue` gained an admin-only "Grant access" panel listing current participants, and
capability-grant entries render as centered session message tags in the thread (e.g. "Alice can now send
invites") — the visible-to-everyone half of the design below.

**Slice 3, shipped:** two more auto-logged `session_log` entry kinds, both signed by the acting
identity's own personal signing key (not admin's — these are plain, publicly-visible facts, not
private grants) and rendered as the same centered session message tags. `invite-sent` (`logInviteSent`) is
written the moment an existing account is invited by public key — never for a join-link invite,
which has no target identity yet to name — rendering as "X invited Y." `joined` (`logJoined`) is
written by `joinExistingSession` itself right after a genuine join (skipped for the `alreadyHasAccess`
no-op path — an account re-opening a link/invite it already redeemed doesn't get a second "joined"
entry), rendering as "X joined by invite" or "X joined by join link." Both go through the same
opportunistic verification as messages (`verifyOpportunistic` in `SessionView.vue`): unverifiable
(sender's signing key not seen yet) renders anyway, a signature that actively fails against a known
key gets dropped. The session-message-tag style itself changed alongside this: no background/border pill
anymore, just centered text flanked by a thin rule on each side (`.session-message-tag::before`/`::after`),
so a growing set of tag kinds doesn't turn the thread into a wall of pills.

**Not yet built: signing invites themselves.** `session_invites`/`join_access` still work exactly as
before Stage E — anyone holding the session key can still mint one, unaffected by the capability
gate above beyond the *inviting client's own UI* refusing to offer it. Real enforcement needs a
receiver-side signature check, and that turns out to be structurally weaker here than the rest of
this design: a first-time joiner has no independent way to know a session's *real*
`adminSigningPublicKey` before joining, since the only copy they'll ever see arrives inside the very
payload the signature would be checked against — unlike a `session_log` entry, which every other
verification here relies on the reader already being a session member (with the payload's admin key
already trusted from their own prior join) to check. Worth doing anyway as tamper-evidence, but it
would not be a real proof of authorization to a stranger the way it is for anyone already in the
session — this needs to be documented honestly as a partial mitigation, not oversold as closing the
gap, whenever it's built.

*Two keypairs per session, both freshly generated at creation, neither derived from anything:*
- `adminEcdhKeyPair` — its private half is what capabilities are derived from.
- `adminSigningKeyPair` (ECDSA) — signs grant and rename records so any member can verify them.

Both public halves ride in `SessionAccessPayload`/`JoinPayload` for everyone, for free. Both private
halves go only into the creator's own `session_access` row. Neither is derived from, or related to,
the creator's own persistent identity key — deliberately. This isn't about hiding who's admin (fellow
participants already learn everyone's real identity within a session they share, same as they always
have via `session_participants`); it's blast radius. A session's admin authority has to be a property
of *that session*, not of the person, so that compromising one session's admin material can never
threaten the creator's real account, and so a capability can be granted/revoked in principle without
touching anyone's actual identity.

*A capability is `SHA-256(adminEcdhPrivateKey || purpose)`* — one-way, the same primitive
`deriveLookupTag` already uses. Admin derives any capability on demand, never stores one. A chain
(`K2 = H(K1 || purpose2)`) stays equally non-invertible at every link — see "Two rejected designs"
for why a chain can't *also* be verifiable by third parties without a signature doing that job
separately.

*Every identity also gets a personal ECDSA signing keypair* — derived from its existing ECDH private
key via the same one-way hash primitive as everything else (`SHA-256(ecdhPrivateKeyBytes ||
"personal-signing")`, reduced mod the curve order, used as the signing private scalar), not generated
independently. This is what makes a message's `sender` field verifiable instead of merely claimed:
today, any participant holding the shared session key could write a message claiming to be anyone
else in the session, since `sender` is just a self-reported field with nothing binding it to the
identity it names. Signing closes that. It adds no new exposure — fellow participants already learn
each other's real public keys via `session_participants` regardless, so a signature over an
already-visible field reveals nothing new to that same audience, it just makes the claim checkable
rather than trusted. Consequence: `session_participants`'s payload grows from a bare public-key-id
string to `{publicKeyId, signingPublicKeyJwk}`, so participants can actually verify each other's
signatures.

Deriving rather than generating independently matters for a concrete reason: a personal/account/guest
link only ever carries one private key today, and generating the signing keypair separately would
mean a link needs to carry two just to be that identity somewhere new — one to read/derive with, a
second to sign with. Deriving it means the link shape never changes; the signing key is always
recomputable on demand from the one secret that link already is. This is safe for reasons different
from why admin's signing key stays independent (see "Two keypairs per session" above): there's no
public-verifiability need here to create the earlier tension, since a signing public key is always
explicitly published via `session_participants` rather than expected to be independently re-derived
by a verifier — and the derived public key is exactly as cross-session-correlatable as the ECDH public
key it's derived from already is, not an additional correlatable value, since the two are always seen
together. Admin's key stays independent because that separation is about a *session-scoped*
credential never touching a *persistent* identity; deriving a personal signing key from a personal
identity key is the same identity expressing a second facet of itself, not one thing borrowing
another's.

*Every `session_log` entry is signed by whoever actually wrote it and carries a `kind`*
(`'message' | 'rename' | 'capability-grant'`, extensible) *inside the decrypted
payload* — no plaintext `kind` column, since nothing needs pre-decryption gating (a forged entry is
already inert once the signature check fails). `kind` decides rendering: messages render as bubbles;
`rename` and `capability-grant` render as centered system-style tags, the same convention chat apps
generally use for "X changed the topic to Y."

*A capability grant is two layers, not one, because it has two different audiences.* Everyone in the
session should see that a grant happened (an ordinary `session_log` entry, signed, session-key
encrypted like anything else) — but only the grantee should be able to use it. So the outer entry
(`{kind: 'capability-grant', granteePublicKeyId, capability, timestamp, signature, sealedSecret}`) is
visible to and verifiable by every participant, while `sealedSecret` is a *second*, independent ECIES
seal to the grantee's real identity key — only they can open it and recover the actual usable
capability key. The signature is over the whole record including `sealedSecret`'s ciphertext, so
swapping in a different sealed payload next to a genuine signature is caught, same reasoning as the
original content-hash-binding fix. The recipient discovers their grant simply by reading the thread
they're already loading — no separate discovery table or scan needed, unlike `session_invites` (see
below for why invites can't work this way). They verify the signature, then self-write the recovered
capability key into their own `session_access` row (`updateSessionAccess`, same self-write-only
pattern Stage C's migration already relies on).

This is a real improvement over an earlier version of this design that used a dedicated
`capability_grants` table mirroring `session_invites`: that table would have had its own visible row
count — "N grants happened system-wide," the same class of leak `session_invites`' count already is.
Folding grants into `session_log` removes that signal entirely: a grant is now indistinguishable from
an ordinary message at the database level. Fewer tables, and strictly less exposed, not more.

*A rename is the simpler, single-layer case* — pure broadcast, no nested seal, since everyone should
see it and no one secret is being delivered: `{kind: 'rename', title, signature}`. The current title
is never stored anywhere; it's resolved live from the latest rename entry in the log a participant is
already loading to read the thread, exactly like a sender's display name is already resolved live
rather than stored — no new fetch, no new traffic pattern. `SessionAccessPayload.title` (inert today
— declared and read defensively, but nothing ever writes it) gets removed once this lands, since it
was the wrong home for this from the start.

*Invites stay structurally separate, and can't be folded into `session_log`* — an invite's entire job
is to deliver the session key to someone who doesn't have it yet, so it's structurally impossible for
an invite to live inside something encrypted *by* that same key. `session_invites`/`join_access`
remain their own app-level mechanism, unaffected. They do gain the same authenticity treatment,
though: an invite gets signed by whoever is actually using the invite capability to send it — admin's
own dedicated signing key for admin-sent invites, or a granted (non-admin) member's own personal
signing key (now that every identity has one) for theirs — and the receiver verifies that signature
before joining, same "prove genuine authority, don't just trust the payload" principle as everything
else here.

*A guarded action (invite, first) needs the capability's private key as an actual argument* — derived
on the fly if admin, read from your own row if granted — so a member with neither has no key material
to pass in at all, not a hidden button.

**Two rejected designs, both verified with standalone scripts before being ruled out:**
1. **Deriving a capability via EC scalar addition** (`k_invite = k_admin + H(purpose)`) instead of a
   hash. This would let anyone verify the capability's public key against the admin's public key
   alone — but the same linearity that enables that means anyone holding the derived *private* key
   trivially recovers the admin's real private key by subtracting the same public offset. This is the
   exact class of weakness BIP32 hardened derivation exists to avoid; confirmed with a script (modular
   arithmetic over a cyclic group) before rejecting it.
2. **Expecting a one-way hash derivation to be independently verifiable at all**, chained or not.
   Mathematically impossible by the definition of one-wayness — if a public function could verify a
   hash-derived key against a public key alone, the hash would have exploitable algebraic structure
   and wouldn't be one-way in the first place. Verifiability is the signature layer's job instead of
   the derivation's; confirmed with a script (ECDSA sign/verify round-trip, tamper and impostor cases
   both correctly rejected) that the signature approach works cleanly alongside a separate ECDH keypair.

## §4 — Shared Logic (lib/)

Pure functions over already-fetched data. These recompute instantly, no refetch. Example:

```
src/lib/
  indicators.ts    e.g., moving average, Bollinger bands
  compute.ts       custom app logic
  utils.ts         helpers
```

Keep functions **pure** — same input → same output, no side effects.

## §5 — Composables

Vue reactive wrappers around data fetches. Example:

```typescript
// src/lib/useMyData.ts
export const useMyData = () => {
  const data = ref([])
  onMounted(async () => {
    data.value = await fetch(...)
  })
  return { data }
}
```

Use these in components to stay reactive without fetch boilerplate.

## §6 — Components

Organized by feature. Keep them thin — mostly templating, logic lives in `lib/` and composables.

```
src/components/
  Modal.vue           generic bottom-sheet/centered overlay (open, title, @close) — every panel that
                      used to expand inline (Invite, invite-by-key, aliases, my key, adopt account)
                      now renders inside one of these instead
  MenuButton.vue      generic ghost-button trigger + options popover (label, tone; scoped-slot gives
                      each option a `select(action)` that closes the popover and runs the action
                      together, and outside-click detection is scoped to the component's own root
                      element) — both AccountHome's Account menu and SessionView's Invite menu use
                      this instead of separately hand-rolling the same open/close/outside-click logic.
                      Its outside-click detection, and SessionView's panel-closing, both go through
                      lib/useOutsideClick.ts — a click alone isn't enough to count as "outside," since
                      mobile Safari can synthesize a trailing ghost click after the tapped element is
                      removed from the DOM; requiring the mousedown to also have started outside
                      filters that out
  HelpModal.vue       renders docs/concepts/overview.md (imported via `?raw`) into the Help modal
  SessionHome.vue     logged-out home: "Start a session", paste-a-link box, "Create an account", and
                      "Log in" (accepts a full account link, any origin, or just the bare key)
  AccountHome.vue     logged-in home: "Signed in as <username>" (top left), an **Account** menu
                      (top right, next to a ghost "Log out") offering "My public key" and "Adopt
                      guest account" — src/api/sessionActions.ts's adoptGuestIdentity, reachable from
                      here regardless of which session a pasted guest identity belongs to — plus
                      chat list sorted by latest activity (src/api/sessionList.ts) and pending
                      invites, + "Start a session"
  CreateAccount.vue   generate an account keypair + username, reveal its one-time account link
  JoinSession.vue     redeem an invite link as the logged-in account, a guest, or by logging in
                      on the spot (pasting an account link) — all via sessionActions.ts
  SessionView.vue     the thread — accepts either a guest packedKey or an account's sessionId. A
                      guest route can migrate to an account in place ("+ Add to account"); an
                      account route shows "Signed in as <username>", tap for that session's adopted
                      aliases. An **Invite** menu offers "By join link" and "By public key"
                      (src/api/inviteActions.ts), each opening its panel in a modal
```

## §7 — Build, Deploy & Conventions

**Local dev:** `npm run dev` (hot reload at http://localhost:5173)

**Build before commit:** `npm run build` (catches TS errors + template parse errors)

**Tests:** `npm test` (Vitest) — pure logic in `src/lib/` (crypto primitives, hash routing, guest
naming) and the non-Supabase-dependent parts of `src/api/sessions.ts`, using a minimal mocked query
builder to catch table/column-name regressions without needing a real backend. Nothing that calls
Supabase for real is exercised here — that's what the E2E layer below is for.
Config lives in `vite.config.ts`'s `test` block (plain Node environment by default, since that
matches how these functions were already being verified — standalone Node scripts using `webcrypto` —
before they became permanent tests; a file needing `window` opts into jsdom via a
`// @vitest-environment jsdom` docblock at its top, see `src/lib/route.test.ts`). Scoped to `src/**`
(`include: ['src/**/*.{test,spec}.ts']`) so it never picks up the Playwright specs under `e2e/`, which
use a different `test`/`expect` entirely.

**End-to-end tests run against the live database.** `npm run test:e2e` (Playwright,
`playwright.config.ts`) drives a real browser against `npm run dev` (not a production build/preview —
`vite-plugin-pwa` only registers a service worker in prod, and a cached SW between runs is the last
thing this suite needs), talking to the actual Supabase project — not a separate test project. That's
a deliberate choice, not an oversight: RLS is `using(true)` everywhere already, so a test-created
account or session is no more exposed than any other row, and there is no other real user yet whose
data a test run could collide with. The alternative (a second Supabase project just for CI) would have
added real setup (schema, secrets, seed/teardown) for a risk this app doesn't currently have.

Every identity a test creates (an account keypair, a guest keypair, an admin) gets handed to the
`manifest` fixture (`e2e/fixtures.ts`) via `manifest.track(packedPrivateKey)` — once per identity, right
after it's created. At teardown the fixture re-derives that identity's `session-access` lookup tag
(the same `deriveLookupTag` call the app itself makes), finds its `session_access` row(s), opens the
sealed payload to recover the `sessionId`, and deletes: the `session_access` row explicitly, plus the
`sessions` row (which cascades to `session_log` and `session_participants` — the only two tables with
a real `ON DELETE CASCADE` FK to `sessions`; confirmed by querying
`information_schema.referential_constraints` directly, since `join_access`, `session_invites`, and
`private_account_state` have no enforced FK at all despite one being described in this doc). This
manifest-based delete is the *primary* cleanup mechanism, not a nice-to-have on top of something
else — it runs whether the test passed or failed, and doesn't depend on any schema change. Its one gap
is a CI runner that dies before the fixture's teardown executes (killed mid-run, cancelled), which
leaves orphaned rows with no automatic backstop; treat that as a manual sweep for now (delete-by-age
against `sessions`/`accounts`) rather than something worth an FK/schema change for, unless it turns out
to happen often.

**Confirmed passing in real CI** (this sandbox's own network can't reach Supabase at all — a 403
policy denial at the proxy, confirmed via the proxy's status endpoint — so GitHub Actions was the
first real signal). The run did surface one real timing issue: a sent message isn't rendered
optimistically (`send()` in `SessionView.vue` only inserts into `session_log`; the bubble appears once
Supabase Realtime echoes the INSERT back through `subscribeMessages`), and the test's default 5s
assertion timeout occasionally isn't enough for a freshly-opened Realtime channel's first round trip —
it flaked once, passed on Playwright's automatic retry (`retries: 1` in CI) a few seconds later. Fixed
by giving that one assertion a 15s timeout rather than relying on the retry to paper over it.

**Production and preview, both via Netlify** (see `netlify.toml`): `main` pushes build production; every other branch/PR gets its own Deploy Preview.

**PR build check:** `.github/workflows/ci.yml` runs `npm run build`, `npm test`, then installs a
Chromium browser and runs `npm run test:e2e`, all inside the one `build` status check the branch
ruleset requires. It doesn't deploy anything.

**Conventions:**
- Components: PascalCase, one per file
- Functions/vars: camelCase
- CSS: BEM or utility classes (avoid specificity wars)
- Types: keep in component file or `types/` folder

## §8 — PWA & Service Worker

`pwa.ts` handles:
- Service worker registration
- Auto-update on new deploys
- Offline detection
- Update available → reload prompt

`main.ts` bootstraps the Vue app + PWA setup.

Service worker is generated by Vite + `vite-plugin-pwa` (auto-configured).

## §9 — Glossary

- **SPA** — Single-Page App (no server-side rendering, runs entirely in the browser)
- **PWA** — Progressive Web App (works offline, installable like a native app)
- **Service Worker** — Background script that handles caching and network requests
- **Deploy Preview** — Netlify's term for a per-branch temporary deploy
- **Build ID** — Git commit SHA, shown in footer for debugging
- **Reload latest** — Force-refresh service worker cache and reload the page

---

**When you change architecture or add a major feature, update the relevant section above + the diagram.**
