# Setup brief

Temporary. `finish-setup` reads this, personalizes the project from it, then deletes it.
If you're reading this, setup hasn't finished — run the `finish-setup` skill.

- **Repo:** mehdidotesk73/whisper-z
- **Netlify site name:** whisper-z  (reserve alternates: whisper-z-mehdi, whisper-z-app)
- **Purpose:** An end-to-end encrypted two-person messaging app — messages are encrypted in the browser before storage, using a key only the two chat participants can derive.
- **UI shape:**
  - Start a chat — creates a session, generates the starter's keypair locally, shows their personal link (carries their private key, to reopen this chat later on this device) plus an invite link to send the other person
  - Join a chat — opened via an invite link; generates the joiner's keypair locally and registers them into the session
  - Chat view — decrypts and displays the thread locally in the browser; shows a "waiting for the other person to join" state until both keypairs are present
- **External data:** None — no third-party APIs. Needs a shared database (Supabase, via the `add-database` skill) to store encrypted messages and public keys so both participants' devices can sync.
- **First feature they described:** The core encrypted chat flow — start a chat, share the invite link, have the other person join, and exchange encrypted messages that only the two participants can decrypt.

## What they said, verbatim

> My app is a messaging app. The app needs messages in a database. The messages are encrypted. The sender has a private key and the receiver has a public key. Both the sender and the receiver on either side can decrypt their messages but noone else can. Users load a session using a session link or session id that is also only accessible by the chat participants.
>
> [Refined after review:]
> App: An end-to-end encrypted two-person messaging app. Messages are encrypted in your browser before they're ever stored, using a key that only the two chat participants can derive — not the server, not the database.
>
> Key behavior — encryption: Each participant gets their own public/private keypair, generated locally when they join a chat. The two keys combine (via a standard key-exchange, the same math both sides get access to) into one shared secret that both participants — and only both participants — can compute. That shared secret encrypts and decrypts every message. Private keys never leave the browser and are never sent to the database.
>
> Sessions: A chat is a "session" identified by a link/ID. Starting a chat generates your keypair and gives you two links: your own personal link (carries your private key so you can reopen this same chat later on this device) and a separate invite link to send the other person, which lets them join and generates their own keypair.
>
> Proposed screens:
> - Start a chat — creates a session, shows your personal link plus the invite link to share
> - Join a chat — opened via an invite link; generates the joiner's keypair and registers them into the session
> - Chat view — decrypts and displays the thread locally in the browser; shows a "waiting for the other person to join" state until both keypairs are present
>
> Worth knowing: since private keys live only in the browser (never on the server), losing your personal link or clearing browser storage means losing access to that chat — there's no password recovery, by design, because recovery would require the server to be able to read your keys.
>
> External data: No external APIs, but the app needs a shared database to store encrypted messages and public keys so both participants' devices can sync — I'll set that up with Supabase in a later step.
