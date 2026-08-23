# whisper-z

An end-to-end encrypted two-person messaging app. Messages are encrypted in your browser before
they're ever stored, using a key that only the two chat participants can derive — not the server,
not the database.

## What it does

- **Start a chat** — creates a session, generates your keypair locally, and gives you two links:
  your own personal link (carries your private key, so you can reopen this chat later on this
  device) and an invite link to send the other person.
- **Join a chat** — opened via an invite link; generates the joiner's keypair locally and registers
  them into the session.
- **Chat view** — decrypts and displays the thread locally in the browser; shows a "waiting for the
  other person to join" state until both keypairs are present.

Private keys never leave the browser and are never sent to the database. Since there's no password
recovery by design, losing your personal link or clearing browser storage means losing access to
that chat.

Built with Vue 3 + TypeScript + Vite (PWA).

## Local development

```bash
npm install
npm run dev           # start dev server (http://localhost:5173)
npm run build          # type-check + bundle
npm run preview        # test production build locally
```

## Live site

- **Production:** https://whisper-z.netlify.app
- **Previews:** every PR gets its own deploy preview on Netlify

## Docs

- [`CLAUDE.md`](./CLAUDE.md) — development workflow and conventions
- [`docs/TODO.md`](./docs/TODO.md) — project backlog
- [`docs/experience.md`](./docs/experience.md) — lessons learned + version history
- [`docs/system-design.md`](./docs/system-design.md) — architecture and technical design
- [`docs/concepts/`](./docs/concepts/) — user-facing help docs
