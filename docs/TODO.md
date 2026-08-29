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
(`src/api/sessionActions.ts`) merges a guest identity's key into `identityPublicKeyIds`, an array on
the account's own `session_access` row for that session — creating that row if the account doesn't
have one yet, or updating it in place (via `updateSessionAccess`) if it already does, rather than
always inserting a second row for the same session. The guest's original `session_participants` row
is never touched; a new one is added for the account's real key only if it doesn't already have one.
Future messages are sent under that real key. A message's displayed sender name is never stored
anywhere — resolved live, purely from `sender`, against `accounts`, with a deterministic (no-lookup)
fallback name derived from the key itself (`guestNameForKey`, `src/lib/guestName.ts`) for a key that
isn't one. That's what makes a migrated identity's *later* messages correctly show the account's
current username to everyone else while its *earlier* ones keep resolving to the same guest name they
always did — nothing here treats "migrated" as a special case anywhere in the render path. Also fixed:
(1) found through the user's own review of the table's design — `session_participants` used to store
an account's real public key in plaintext, which — combined with `using (true)` RLS — let anyone with
database access recover which sessions an account has ever joined directly, defeating
`session_access`'s whole hidden-membership-graph design for every account (not guests); each row's
identity is now symmetrically encrypted with the session's own shared key instead (same functions
`messages` already uses), leaving only `session_id` as plaintext lookup metadata. (2) found through
live device testing — an account that had already joined a session directly under its own key, then
migrated in a *different* guest identity from the same session, never actually recognized that
guest's old messages as its own, because the old single-key `identityPublicKeyId` field and its
too-coarse idempotency check silently no-opped instead of merging; fixed by the array + merge-in-place
design described above. See "An account can migrate a guest session it already holds", "A message's
displayed sender name is resolved live", and "`session_participants` is keyed by plaintext
`session_id`" in `docs/system-design.md` §3.

## Next (Current Sprint)

Continuing the session-model rebuild, in order:

- [ ] **Stage D** — real multi-participant support: verified/polished the existing link-based join
      for 3+ people (nothing capped participant count to begin with); session list now sorts by
      latest-message time instead of the originally-planned grouped-by-participant view; added
      `session_invites` — add an existing account by a public key exchanged **out of band**
      (physically), not looked up by username, since a server-side lookup would itself be an
      observable event correlatable to whatever the inviter does next. Uses a pairwise ECDH secret
      (`derivePairwiseSecret`/`derivePairwiseTag`/`derivePairwiseKey`, `src/lib/crypto.ts`) so both
      sides independently derive an identical, indexable tag with no ephemeral key and no lookup —
      a database dump sees only opaque `{tag, ciphertext}` rows. Accepting an invite is exactly
      `joinExistingSession`; rejecting/undoing is a delete, client-checked only (see
      `docs/system-design.md` §3's "Deletion is client-checked only" for why that's an accepted,
      pre-existing gap, not a new one) — an inviter's "Undo" only works while the invite is still
      in memory from just having sent it, not a real cancel, since the row has no owner reference a
      later visit could reconstruct. The originally-planned `accepted`-flag/view-only-enforcement
      idea was dropped along with username-based invites — it only existed to gate consent for
      being added without acting, and every real join path already requires an affirmative action
      (a link click, or accepting an invite) that already is that consent. Also added: a "Log in"
      option on the logged-out home (`extractAccountKey`, accepts a full link on any origin or a
      bare key — fixed a real regression this surfaced, where every key created before `deriveBits`
      was added to `generateKeyPair` failed to import at all, see `docs/experience.md`); "Adopt guest
      account" (`adoptGuestIdentity`, `src/api/sessionActions.ts`) on `AccountHome.vue`'s **Account**
      menu — account-level, not tied to any open session, since a guest identity's own single
      `session_access` row is enough to find which session it belongs to — plus a per-session
      "Logged in as `<username>`" aliases view on `SessionView.vue`'s account-backed route, scoped to
      the currently-open session on purpose — see "Why there's no account-wide list of my aliases" in
      `docs/system-design.md` §3. UI pass after live testing: Invite/invite-by-key/aliases/my-key/
      adopt-account all moved from inline-expanding panels into a shared `Modal.vue` overlay,
      "Invite" collapsed into one menu button ("By join link"/"By public key"), and top-bar buttons
      got a ghost (outline, no fill) variant for lower-emphasis actions like Home/Log out.
- [ ] **Stage E** — rename/remove a session from your list, plus pin/favorite a session (deferred
      here from Stage D's list-sort work: sessions with a pin would sort above latest-activity
      order, not yet designed). Also carries a proposed auto-naming design (from live testing, after
      seeing a guest's deterministic name show up in an account's chat list — correct, but a little
      rough since it's not something anyone chose): a session auto-names itself from its
      participants' usernames, concatenated, plus an invisible marker recording "this title is still
      auto-generated." As participants change, an auto-generated title keeps regenerating. The first
      time anyone renames it (or clears it back to empty, on one design option), the marker goes away
      and it stops auto-updating — a title only a real edit ever produces again. Needs a concrete
      design before starting: probably a plain `titleIsAuto: boolean` alongside `title` rather than
      literally hiding a marker inside the rendered string (fragile — collides with a user's own
      chosen title that happens to match the auto format, ambiguous on rename-to-empty)

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
- No protection against network/IP-level traffic correlation — the schema hides the membership
  graph from database *content*, but not from anyone who can see requests reaching the server (the
  operator, or a network observer): a stable tag repeatedly fetched from the same IP is a real
  pattern, and one moment of IP-to-identity linkage (a signup, an ISP log) connects backwards to
  everything that IP/tag ever touched. Out of scope to fix here — VPN/Tor is the user's own
  mitigation, not something the app provides. Documented honestly in `docs/concepts/overview.md`
  and `docs/system-design.md` §3, not silently assumed safe
- **Future phase, deliberately deferred — admin/capability model (design worked out, not built):**
  each session gets a second, asymmetric keypair (distinct from the existing symmetric content key)
  at creation — the admin *public* key rides along in `SessionAccessPayload` (everyone gets it, for
  free, no new leak); the admin *private* key is the capability itself, delivered to whoever holds
  admin rights by updating their `session_access` row (same `updateSessionAccess` mechanism Stage C's
  migration merge uses). No RLS lock-down or Edge Function needed for this specifically: a forged
  "grant admin" claim can't actually hand anyone a working private key, so it's inert — capability
  security instead of server-checked security. What this does *not* give you: revocation (once
  someone has held the key, they keep the ability forever; removing it means rotating to a new
  keypair and redistributing it) — deliberately punted, admin-forever is fine for now. Actions/log
  entries would fold into a renamed `messages` → `session_log` table, type-tagged only inside the
  ciphertext (no plaintext `kind` column needed, since nothing needs pre-decryption gating once
  forged actions are already inert)
- **Even further out, deliberately deferred — tamper-evident history:** periodically hash-chain
  `session_log` snapshots and have participants cross-check the latest hash with each other
  (catches a compromised DB operator secretly rewriting or rolling back history — nothing else in
  this design protects against that). Anchoring the hash on an external blockchain was considered
  and explicitly rejected as disproportionate for this app's scale (real fees/latency, and it still
  doesn't solve equivocation — a malicious operator showing different users different histories —
  without the same participant cross-check anyway, at which point the external chain adds little)
- A Supabase Edge Function as a general RLS-bypassing gate for security-sensitive mutations was the
  first idea explored here and is **not** the direction taken — the capability model above needs no
  such gate for authority; an Edge Function may still matter later for cryptographic operations
  Postgres itself can't do (e.g. real ECDSA verification), if a use case for that specifically
  arises
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

(Bugs, edge cases, platform-specific quirks)

## Ideas / Backlog (Low Priority)

(Features to explore later, might-nots, "wouldn't it be cool if...")
