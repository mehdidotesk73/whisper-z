# TODO — Project Backlog

Track feature development, improvements, and known issues here. Move completed work to **Done**, queue new ideas under **Next**, and record blockers in **Blocked**.

## Done

**Core encrypted chat flow** (v0.2.0) — Start a chat / Join a chat / Chat view, switched by a
hash-based router. Each side generates an ECDH (P-256) keypair locally; combining your private key
with the other side's public key derives a shared AES-GCM key that only the two participants can
compute. Private keys live only in each participant's personal link (URL fragment), never sent
anywhere. Messages sync through a new Supabase backend (`sessions`, `messages` tables, realtime
subscriptions) so two separate browsers can actually hold a conversation. Key functions:
`generateKeyPair`/`deriveSharedKey`/`encryptText`/`decryptText` (`src/lib/crypto.ts`),
`createSession`/`joinSession`/`subscribeMessages` (`src/api/session.ts`).

**Accounts, stage 1** (v0.3.0) — optional account layer on top of the same chat system: an account
is a keypair + username (no password, an account link carries the private key, remembered in this
device's `localStorage` until logged out). Starting/joining a chat while logged in attaches it
automatically; an existing chat's personal link can be pasted in to attach it too. Attaching wraps
the chat's private key under the account's public key, reusing the same ECDH+AES-GCM primitives as
messages (`wrapPrivateKey`/`unwrapPrivateKey`). `AccountHome.vue` shows the resulting chat list.
Schema: `accounts`, `chat_memberships` — see §3b in `docs/system-design.md`.

## Next (Current Sprint)

**Accounts, stage 2** — starting a chat directed at someone's public key (shared out-of-band, not
looked up by username — usernames are just a display label, not a directory) instead of the
invite-link round-trip. The starter can send immediately; the recipient only sees/can respond to it
after accepting. `chat_memberships.status` (`active`/`pending`) is already in the schema for this.

One-time setup — tick these off as they're done:

- [x] Connect Netlify (finish-setup) — required; gives previews AND the production site
- [x] Protect `main` (finish-setup) — required; makes changes arrive as PRs with previews
- [x] First feature: the core encrypted chat flow

## Code

- Messages currently have no "delivered"/"read" state or typing indicator — realtime `postgres_changes`
  gives durability but nothing live-only; would use Supabase Broadcast alongside it if wanted (see
  "Live is not the same as stored" in `docs/experience.md`)
- No out-of-band key verification ("safety numbers") — a compromised first key exchange isn't
  detectable. Documented honestly in `docs/concepts/overview.md`, not silently assumed safe
- No forward secrecy — keys are static per session, so one compromised private key decrypts the
  whole history. A Double Ratchet–style rotation would be a much bigger build
- Group chat isn't supported — the schema and key derivation are both pairwise by design
- Account login is link-only, no password — noted as upgradeable later (wrap the same account key
  under a password-derived key instead of/alongside the link) without touching anything else

## Docs

(Documentation gaps, missing help content, outdated instructions)

## UI / UX

(Design improvements, accessibility, mobile issues)

## DevOps / Build

(CI/CD, deployment, build process improvements)

## Known Issues

(Bugs, edge cases, platform-specific quirks)

## Ideas / Backlog (Low Priority)

(Features to explore later, might-nots, "wouldn't it be cool if...")
