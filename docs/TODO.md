# TODO — Project Backlog

Track feature development, improvements, and known issues here. Move completed work to **Done**, queue new ideas under **Next**, and record blockers in **Blocked**.

## Done

**Core encrypted chat flow** (v0.2.0, superseded — see below) — the original Start a chat / Join a
chat / Chat view, replaced in v0.4.0 by the session model.

**Session model rebuild, stage A of the roadmap below** (v0.4.0) — Start a session / Join a session /
Session view on a new schema built for a hidden membership graph and (eventually) more than two
participants. One shared AES-256 key per session instead of a pairwise ECDH-derived key; the
database can't see which sessions an identity belongs to, only that a lookup tag has some rows.
Key functions: `sealForRecipient`/`openSealed`/`deriveLookupTag`/`generateSessionKey`
(`src/lib/crypto.ts`), `createSession`/`insertSessionAccess`/`sendMessage` (`src/api/sessions.ts`).
See §3 in `docs/system-design.md` and "Rebuilding the Chat Model for a Hidden Membership Graph" in
`docs/experience.md` for the full design and what was deliberately scoped out.

**Stage B: accounts + hidden session index** (v0.5.0) — accounts reuse the exact guest
mechanism (keypair + `deriveLookupTag('session-access')`) with one difference: the keypair is
stable, so one query rebuilds a whole chat list (`src/api/sessionList.ts`). New
`#/mysession/<sessionId>` route disambiguates which of an account's many sessions a chat-list tap
means, since a bare personal link can no longer assume "the one session" once an account holds more
than one. `accounts.public_key` is the one intentionally searchable identity value in the schema.
Also shipped in this stage's PR after live testing: single-use expiring invite links, an
already-a-member guard, "Join as guest/existing user/`<username>`", and live username resolution
for account holders in the thread. See the "account is just another identity" + "why a personal
link isn't enough" entries in `docs/system-design.md` §3.

**Stage C: guest → account migration** (pending) — `migrateGuestSessionToAccount`
(`src/api/sessionActions.ts`) adds an account's own `session_access` row to a session it currently
only holds as a guest, without touching `session_participants` or re-keying anything: the new row
pins `identityPublicKeyId` to the guest's original public key, so the session keeps counting as that
one identity for access purposes forever. What a message displays as its sender is a separate,
self-declared field (`senderName`, baked in by the sending client at send time — no lookup, no new
table) rather than something resolved from `session_participants` after the fact, which is what lets
a migrated identity's *later* messages correctly show the account's live username to everyone else
while earlier ones keep showing whatever name was true when they were sent. See "An account can
migrate a guest session it already holds" and "A message's displayed sender name is self-declared"
in `docs/system-design.md` §3.

## Next (Current Sprint)

Continuing the session-model rebuild, in order:

- [ ] **Stage D** — real multi-participant support: invite by public key into an existing session,
      an `accepted` flag with view-only enforcement (client-checked, not server-verified), a
      collapsible session list grouped by other participant
- [ ] **Stage E** — rename/remove a session from your list

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
- **Future feature, deliberately deferred:** a Supabase Edge Function as the sole server-side
  capability verifier, plus the fine-grained `K_INVITE_MEMBER`/`K_GRANT_ADMIN`-style permission
  system it would actually enforce. Without the verifier, permissions beyond owner/member are UI
  suggestions, not real boundaries — see `docs/experience.md` for the full reasoning
- Invite links are single-use and expire after 10 minutes now (`claimJoinAccess`,
  `isJoinAccessExpired` in `src/api/sessions.ts`), but any participant — not just the session's
  owner — can currently mint one. Restricting that to the owner needs a `role` check in
  `SessionView.vue`'s Invite button, which is easy client-side but, like everything else here, not
  server-enforced until the capability verifier above exists

## Docs

(Documentation gaps, missing help content, outdated instructions)

## UI / UX

(Design improvements, accessibility, mobile issues)

## DevOps / Build

(CI/CD, deployment, build process improvements)

## Known Issues

- A migrated guest identity's entry in an account's chat list ("other participants" preview) can
  still show the frozen guest name from `session_participants`, even though the thread itself
  correctly shows that person's live account username (see "A message's displayed sender name is
  self-declared" in `docs/system-design.md` §3). The list preview isn't built from message history,
  so it has no `senderName` to read — would need either a schema change or a "most recent sender
  name" lookup to fix, neither done yet since it's cosmetic (a list-row label), not a privacy or
  correctness issue

## Ideas / Backlog (Low Priority)

(Features to explore later, might-nots, "wouldn't it be cool if...")
