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
  id uuid pk, owner_pub text, ciphertext text, iv text,
  ephemeral_public_key text, created_at
)

join_access (                                                -- a redeemable invite link
  id uuid pk, ciphertext text, iv text, created_at
)

session_participants (                                       -- who's in a session (plaintext — see below)
  id uuid pk, session_id fk → sessions, public_key text,
  display_name text nullable, created_at
)

messages (
  id uuid pk, session_id fk → sessions, ciphertext text, iv text, created_at
)

accounts (                                                    -- a stable, intentionally searchable identity
  id uuid pk, username text unique, public_key text unique, created_at
)

private_account_state (                                       -- reserved for Stage C (guest→account migration)
  id uuid pk, owner_pub text, ciphertext text, iv text,
  ephemeral_public_key text, created_at
)
```

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

**Why `session_access.owner_pub` isn't a real public key.** A participant's actual public key is
already public information (`session_participants.public_key`, or an account's directory entry in
a later stage) — using it directly as the lookup column for "which sessions does this identity
have" would let anyone who already knows that public key run exactly that query and reconstruct the
membership graph. Instead, `owner_pub` is `deriveLookupTag(privateKey, 'session-access')`: a
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
secret in the fragment. Redeeming it (`claimJoinAccess`) is a single `DELETE ... RETURNING`
statement, not a read followed by a separate delete — Postgres only lets one of any number of
concurrent callers actually delete a given row, so if two people click "Join" on the same link at
once, exactly one gets the row back and the other gets `null`. That's what makes this genuinely
single-use rather than best-effort. It also expires: `isJoinAccessExpired` compares `created_at`
against a 10-minute TTL (`JOIN_LINK_TTL_MS`), checked both when the link is first opened (so a stale
link shows as invalid immediately) and again at the atomic claim (so a link that goes stale between
opening and clicking "Join" still can't be redeemed) — no cron job needed, since an expired row is
simply deleted the next time anyone tries to claim it. Inviting a second person means generating a
second link (the Invite panel's "New link, for another person"). Any participant, not just the
session's owner, can currently mint an invite link — restricting that to the owner is one of the
still-open gaps tracked in `docs/TODO.md`, alongside real (server-verified) role enforcement.

**`session_participants` is deliberately plaintext, and that's fine.** It holds who's in a
*specific, already-known* session — every legitimate participant already sees this by definition of
being in the conversation, so hiding it from them buys nothing. What must stay hidden is the
different fact of *which sessions a given identity belongs to across the whole table*, which is
exactly what the `session_access` lookup-tag design above protects. `display_name` is set for a
guest (a random name, `randomGuestName()`) and left `null` for an account holder once accounts
exist, whose current username is meant to be resolved live instead of frozen at join time.

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

**Why a personal link isn't enough once an account exists: the `mysession` route.** A bare private
key resolves to "whichever `session_access` row that tag has" — fine when there's exactly one, which
is true for every guest identity by construction (a fresh keypair per session). An account's tag can
have many. So opening a session from a chat list uses `#/mysession/<sessionId>` instead of
`#/session/<packedKey>`: `SessionView` uses the *logged-in account's* keypair to fetch every row
under its tag, then opens each envelope until it finds the one whose decrypted `sessionId` matches
the route — the id in the URL is just a disambiguator, never a capability, since it's meaningless
without the account's private key to actually open anything. This is also the flag that turns off
the **Warning** control: an account-backed session is always recoverable via the account's own link,
so there is nothing to warn about losing.

**Messages carry their sender inside the ciphertext, not a column.** A decrypted message is
`{ sender: <public key JSON>, text, createdAt }` (`src/lib/sessionTypes.ts`). `SessionView` decrypts
each row with the session key, matches `sender` against its own public key for "mine" styling, and
looks up everyone else's current name via the in-memory `session_participants` map kept live by a
realtime subscription — so a message's displayed sender name can update if that mapping changes
later (relevant once guest→account migration lands), without rewriting the message itself.

**No "waiting for the other side" state anymore.** Because the session key isn't derived from a
second person's public key, the creator has full read/write access to their own session the instant
they create it — `SessionView` opens straight into the thread, with an **Invite** control that
reveals a join link on demand and a **Warning** control (shown whenever the current identity has no
account to fall back on) explaining that closing the tab without saving the personal link means
permanent loss of access.

**What the server can and can't see:** ciphertext is opaque, exactly as before. What's new here is
that the *membership graph itself* — which sessions a given identity/account touches — is opaque
too, not just message content. Metadata that remains visible: that a session exists, roughly when
messages were sent, how many `session_access` rows a given lookup tag has (existence/count, not
which sessions). There's still no out-of-band key verification and no forward secrecy — same
honest caveats as before, now joined by "an active database attacker with write access could still
tamper with a row in ways an honest client would reject, but nothing here stops that at the server;
see `docs/experience.md` for why that's deliberately out of scope for now."

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
  HelpModal.vue       renders docs/concepts/overview.md (imported via `?raw`) into the Help modal
  SessionHome.vue     logged-out home: "Start a session" + paste-a-link box + "Create an account"
  AccountHome.vue     logged-in home: chat list (src/api/sessionList.ts) + "Start a session"
  CreateAccount.vue   generate an account keypair + username, reveal its one-time account link
  JoinSession.vue     redeem an invite link — account-aware via sessionActions.ts
  SessionView.vue     the thread — accepts either a guest packedKey or an account's sessionId
```

## §7 — Build, Deploy & Conventions

**Local dev:** `npm run dev` (hot reload at http://localhost:5173)

**Build before commit:** `npm run build` (catches TS errors + template parse errors)

**Production and preview, both via Netlify** (see `netlify.toml`): `main` pushes build production; every other branch/PR gets its own Deploy Preview.

**PR build check:** `.github/workflows/ci.yml` runs `npm run build` on every PR — this is the `build` status check the branch ruleset requires. It doesn't deploy anything.

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
