# System Design — Architecture & Patterns

Developer-facing documentation of how the app is structured, how data flows, and design decisions.

## §1 — System Overview

This is a Vue 3 + TypeScript + Vite single-page app (SPA) that works as a progressive web app (PWA). It provides:

- **Header/footer shell** — app title, Help modal, build/version info, reload affordance, debug panel
- **Service-worker caching** — offline capability, smart update detection
- **Mobile-first UX** — responsive, touch-optimized, no hover-only interactions
- **Three screens** (`src/components/ChatHome.vue`, `JoinChat.vue`, `ChatView.vue`), switched by a
  hash-based router (`src/lib/route.ts`) — no `vue-router`, just enough parsing for three states
- **Pure computation layer** (`src/lib/`) — key agreement, encrypt/decrypt, routing, clipboard
- **Data layer** (`src/api/`) — the Supabase client and session/message reads, writes, and realtime
  subscriptions
- **Hot reload in dev** — instant feedback on code changes
- **Netlify** — production site and a live preview on every branch/PR, one host
- **Supabase** — shared Postgres database so two browsers can sync a conversation; see §3a

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
│  │      ChatHome │ JoinChat │ ChatView│ │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  lib/ (pure functions)            │  │
│  │  ├─ crypto.ts (ECDH + AES-GCM)    │  │
│  │  ├─ route.ts (hash router)        │  │
│  │  └─ clipboard.ts                  │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  api/ (Supabase data access)      │  │
│  │  ├─ supabase.ts (client)          │  │
│  │  └─ session.ts (reads/writes/     │  │
│  │      realtime subscriptions)      │  │
│  └───────────────────────────────────┘  │
└──────────────────┬──────────────────────┘
                    │ ciphertext + public keys only
                    ▼
┌─────────────────────────────────────────┐
│   Supabase (Postgres + Realtime)        │
│   sessions, messages — see §3a          │
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

## §3 — Data Layer (api/)

Where to put external data fetches. Example structure:

```
src/api/
  example.ts       fetch & cache logic
```

Keep fetches synchronous from the component's perspective using a composable (below) that caches results.

## §3a — Chat Data Model & Trust Model

Two tables in Supabase, link-only sharing (a session's `id` is its own access key — see the
honest-version-of-"anyone with the link" caveat in `docs/experience.md`):

```sql
sessions (id uuid pk, starter_public_key text, joiner_public_key text nullable, created_at)
messages (id uuid pk, session_id fk → sessions, sender 'starter'|'joiner', ciphertext text, iv text, created_at)
```

**Key agreement:** each side generates an ECDH (P-256) keypair locally (`src/lib/crypto.ts`,
`generateKeyPair`). Only the public half is ever written to `sessions`. Starting a chat writes
`starter_public_key`; joining writes `joiner_public_key` (guarded by
`.is('joiner_public_key', null)` so a second visitor to the same invite link can't overwrite the
real joiner). Once both public keys exist, each side derives the identical AES-GCM key from *their
own private key + the other side's public key* (`deriveSharedKey`) — the shared secret itself is
never transmitted or stored.

**Where the private key lives:** nowhere but the URL. `ChatHome`/`JoinChat` export the freshly
generated private key as a JWK, pack it into a URL-safe string (`jwkToUrlSafe`), and put it in the
fragment of that participant's **personal link** (`#/chat/<sessionId>/<role>/<packedKey>`). A
fragment never leaves the browser (not sent to any server, including Netlify), so the only way to
recover a chat is to still have that link. Losing it is unrecoverable by design — see
`docs/concepts/overview.md`.

**Message flow:** `ChatView` fetches existing `messages` rows and decrypts each with the derived
key, then subscribes to `postgres_changes` INSERTs on `messages` (filtered to the session) for new
ones — including its own sends, which round-trip back through the same subscription rather than
being rendered optimistically. It also subscribes to UPDATEs on `sessions` while waiting, so the
"waiting for the other person to join" screen resolves the moment the other side's public key
appears, without a page reload.

**What the server can and can't see:** `ciphertext`/`iv` are opaque to anyone reading the database
directly — same protection described in "End-to-End Encryption Over a Database You Don't Trust" in
`docs/experience.md`. Metadata (that a session exists, roughly when messages were sent, message
count) is not hidden. There's no out-of-band key verification (no "safety numbers"), so a
compromised or MITM'd first exchange isn't caught — acceptable for this app's scope, called out
honestly in the Help doc rather than oversold.

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
  HelpModal.vue      renders docs/concepts/overview.md (imported via `?raw`) into the Help modal
  ChatHome.vue        "Start a chat" + the created session's personal/invite links
  JoinChat.vue        "Join chat" via an invite link + the joiner's own personal link
  ChatView.vue        waiting state, decrypted thread, composer
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
