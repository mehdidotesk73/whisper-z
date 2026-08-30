# CLAUDE.md

Guidance for any Claude session working in this repo. Read this first. The
repeatable procedures live in `.claude/skills/` — `finish-setup` for one-time
setup, `ship-feature` for every change after that.

## ⚠️ FIRST: Is `docs/setup-brief.md` present?

**Check before reading anything else.** If this repo has a `docs/setup-brief.md`, then it is
somebody's freshly scaffolded project waiting to be set up — **not** the template, and **not** a
project needing a new repo. Invoke the **`finish-setup`** skill and ignore the entire bootstrap
below; it has already run. The brief holds the intake answers from the session that created this
repo, and `finish-setup` deletes it once personalization is done.

Everything below applies only when that file is absent.

## What this is

A Vue 3 + TypeScript + Vite single-page app (also a PWA) that is an end-to-end encrypted
two-person messaging app — messages are encrypted in the browser before storage, using a key only
the two chat participants can derive. UI structure:

- **Start a chat** — creates a session, generates the starter's keypair locally, shows their
  personal link (carries their private key, to reopen this chat later on this device) plus an
  invite link to send the other person
- **Join a chat** — opened via an invite link; generates the joiner's keypair locally and registers
  them into the session
- **Chat view** — decrypts and displays the thread locally in the browser; shows a "waiting for the
  other person to join" state until both keypairs are present

The entire app is wrapped inside a header and footer. The header provides the app title, a Help button that opens the conceptual-docs modal, and an "Update available" affordance that surfaces when a newer PWA build is live. The footer provides the current build id/timestamp, version-check status against the live origin, a "Reload latest" button to force-refresh a stale cache, and a collapsible debug log with copy-to-clipboard support. See `docs/system-design.md` §2 for the full wrapper template and implementation details.

The user previews on a **phone** (mobile Safari), so favour mobile-friendly layouts and remember there's no dev console on device — see Debugging below.

## Getting Started

**Setup not finished?** Check the checklist under **Next** in `docs/TODO.md`. If
anything there is unticked, run the **`finish-setup`** skill — it's resumable and
does only what's outstanding.

**Ready to build?** Every change goes through **`ship-feature`**. See below.

## Development lifecycle

Every change — feature, fix, or tweak — goes through the **`ship-feature`** skill
(`.claude/skills/ship-feature/SKILL.md`): branch off `main`, build before each
commit, push, wait for the Netlify preview, run the pre-merge doc gate, open the
PR, hand the user preview + live + merge links, then watch the production deploy
after they merge.

Two rules that hold regardless:

- **Never work on `main`.** It's protected; pushes are rejected. If you find
  yourself on it, branch before doing anything.
- **The user merges, not you.** They can't merge what they can't find, so a PR
  turn always ends with the links.

**The skills in `.claude/skills/` are a copy, not a subscription.** This project
was scaffolded from a template by file copy, so fixes made to that template since
never arrive on their own. The **`update-skills`** skill pulls them in. Worth
offering when a step in setup or shipping goes wrong in a way that sounds like a
known bug — but don't run it mid-feature; it's housekeeping, not a fix for
whatever they're actually asking about.

## Build & verify

- **Type-check + build:** `npm run build` (runs `vue-tsc -b && vite build`).
  This is the gate — it catches TS errors _and_ Vue template parse errors.
  **Run it before every commit.** A broken build has reached history before
  because nothing ran it; don't let that happen.
- **CI runs the same build on every PR** (`.github/workflows/ci.yml`, check name `build`), and the
  branch ruleset requires it to pass before merge. That's a backstop, not a substitute: run
  `npm run build` locally before pushing rather than letting CI find it — a red check on the user's
  PR is noise they have to interpret.
- **Tests:** `npm test` (Vitest, `vitest run`) covers `src/lib/`'s pure logic (crypto primitives, hash
  routing, guest naming) and `src/api/sessions.ts`'s non-Supabase-dependent logic and mocked query
  shape. **Run it alongside `npm run build` before every commit that touches tested code** — CI runs
  both in the same `build` check. Nothing that calls Supabase for real is tested end-to-end (see "No
  third-party APIs" below); those still need the user's live device testing.
- **No third-party APIs.** The app has no external data dependencies today. It will need a shared
  database (Supabase, via the `add-database` skill) once messages have to sync between the two
  participants' devices — until that's wired up, storage and sync **cannot be reproduced in this
  sandbox**, so reason about the encryption/session logic from the code and lean on the user's
  on-device screenshots/logs to validate. Be honest about what you can't verify offline.

## Deploys

- **Netlify does both jobs** (`netlify.toml`): pushes to `main` build the **production** site at
  https://whisper-z.netlify.app; every other branch/PR gets its own **Deploy Preview**
  at `deploy-preview-<n>--whisper-z.netlify.app`. One host, one build pipeline — nothing
  else to configure for hosting.
- **`.github/workflows/ci.yml` only runs the build check on PRs** — it doesn't deploy anything. Its
  sole job is the `build` status check the branch ruleset requires (see Build & verify).
- **`package-lock.json` is committed and must stay that way** — CI runs
  `npm ci`, which fails outright without a lockfile in sync with
  `package.json`. Commit the lockfile whenever you change dependencies.

## Repo structure

```
src/
  App.vue                  header/footer shell (see docs/system-design.md §2) + tab/page content
  main.ts, pwa.ts          bootstrap; service-worker auto-update + reload
  debug.ts                 on-screen log: auto-captures errors + logDebug() (mobile has no console)
  env.d.ts                 ambient types: vite/client, PWA virtual module, __BUILD_ID__/__BUILD_TIME__
  api/                     Supabase client + data access, once the shared database is wired up
  lib/                     pure computation — key derivation, encrypt/decrypt, session helpers
                           (*.test.ts co-located per file — Vitest, see Build & verify)
  components/
    HelpModal.vue          renders docs/concepts/*.md into the Help modal
    <feature components>   one component per screen — Start chat, Join chat, Chat view
.claude/skills/
  finish-setup/SKILL.md    scaffold personalization + one-time hosting setup
  ship-feature/SKILL.md    the change loop: branch → build → PR → links → doc gate
  add-github-pages/SKILL.md   optional: a Netlify-independent production mirror, on request
  add-database/SKILL.md    Supabase setup, when data must outlive one browser or be shared
  update-skills/SKILL.md   pull newer skills from the template this project was copied from
docs/
  TODO.md                  living backlog (Done / Next branch / Housekeeping)
  experience.md            what didn't work + per-merge version history
  system-design.md         developer/system docs (§2 has wrapper template)
  concepts/*.md            per-page user docs (rendered into the Help modal)
public/
  favicon.svg, logo-192.png, logo-512.png   placeholder icons — replace with real branding
.github/workflows/ci.yml       build + test check on every PR (required by the branch ruleset)
netlify.toml                   preview-deploy config (Netlify)
package-lock.json              committed — CI runs `npm ci` and needs it
```

## Conventions & gotchas

- **Charts use ECharts** (if applicable — add when needed). Two known gotchas:
  - On a **category x-axis**, `visualMap` and per-segment `lineStyle` colour do
    **not** bind; for per-point colour use a series with per-point `itemStyle`.
  - Any chart library needs explicit registration in `echarts.use([...])`.
- **Pure logic lives in `src/lib/`** as plain functions over the already-fetched
  data — they recompute instantly with no refetch. Keep new computation there and
  keep components thin.
- **Indicators are heuristics, not advice.** Surface that in the UI, and be
  candid about in-sample / overfitting / scale caveats (if applicable).
- **Mobile-first:** the user is on a phone. Keep controls tappable.

## Debugging on device (no console)

- **Errors are captured automatically.** `installErrorCapture(app)` in
  `main.ts` routes four sources into the on-screen log: Vue's
  `errorHandler` (throws inside event handlers, hooks and watchers — the
  "button does nothing" case), `console.error`/`console.warn`, `window.error`
  (including failed resource loads), and `unhandledrejection`. Nobody has to
  have anticipated the failure for it to be visible.
- The footer shows **View logs** with a red count badge when errors exist;
  the panel has **Copy log**, which includes build id, user agent and URL.
  **Ask for it by name** — "tap View logs, then Copy log, and paste it here"
  — rather than asking what they see. Repeated identical errors collapse to
  `×N`, so a handler firing every tap can't flush the buffer.
- `logDebug(msg, kind?)` still exists for deliberate diagnostics. When
  something's invisible on device, add a **one-shot, guarded** one (in
  `onMounted`, wrapped in try/catch) and ask for the log. Remove or quiet
  noisy logs before merge.

## Reference docs

- `.claude/skills/finish-setup/SKILL.md` — scaffold personalization + one-time hosting setup (resumable).
- `.claude/skills/ship-feature/SKILL.md` — the loop for every change.
- `.claude/skills/add-github-pages/SKILL.md` — optional Netlify-independent mirror, on request.
- `docs/TODO.md` — current backlog and what's been done.
- `docs/experience.md` — dead ends (with reasons) + version history.
- `docs/system-design.md` — developer/system documentation; §2 contains the wrapper template.
- `docs/concepts/*.md` — per-page user docs, also rendered into the Help modal.
