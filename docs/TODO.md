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

## Next (Current Sprint)

Continuing the session-model rebuild, in order:

- [ ] **Stage B** — accounts (keypair + username) with a chat list built by decrypting opaque
      `session_access` rows; a database dump reveals nothing about which sessions an account holds
- [ ] **Stage C** — guest → account migration via a personal link, with a private identity alias so
      history renders correctly with no special-casing
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
