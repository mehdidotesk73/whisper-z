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

## Version History

(Record major releases here as you merge features. Example format below.)

### v0.3.0 — 2026-08-27 (Stage 1 of 2)
- **Added:** Optional accounts — an account is a keypair + username, same custody model as a chat
  (an account link carries the private key, no password), plus this device remembers it in
  `localStorage` until logged out. `AccountHome.vue` shows a chat list instead of one link per chat.
- **Key insight:** attaching a chat to an account needed no new crypto — `wrapPrivateKey`/
  `unwrapPrivateKey` in `src/lib/crypto.ts` reuse the same ECDH+AES-GCM primitives from v0.2.0,
  applied to "encrypt a key" instead of "encrypt a message." See §3b in `docs/system-design.md`.
- **Refactor:** starting/joining a chat is now one shared function (`src/api/chatActions.ts`) used
  by `ChatHome`, `JoinChat`, and `AccountHome` alike, so "attach automatically if logged in" lives in
  one place instead of three.
- **Deferred to stage 2:** starting a chat directed at someone's public key (no invite-link
  round-trip) with an accept step before they can respond. Schema (`chat_memberships.status`) is
  already in place; the code isn't yet.

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
