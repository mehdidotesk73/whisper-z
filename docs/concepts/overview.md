# About whisper-z

An end-to-end encrypted messaging app. Messages are encrypted in your browser before they're ever
stored — not the server, not the database, only the people in a session can read them.

## Starting a session

Tap **Start a session**. Your browser generates a keypair and a random key for that session on the
spot — nothing is typed in, nothing sent anywhere except what's needed to invite others. The
session opens immediately: you can start typing right away, even before anyone else has joined.

From inside the session:
- **Invite** reveals a link you can send to someone so they can join.
- **⚠ Warning** reveals your **personal link** — save it (bookmark it, message it to yourself) so
  you can reopen this exact session later on this device. Closing the tab without saving it means
  losing access for good; there's no password and no recovery.

## Joining a session

Open the invite link you were sent and tap **Join session**. If you're not signed in, this
generates your own keypair and adds you to the conversation — you'll land in the same thread, with
your own personal link available the same way. If you're signed in to an account, it's added
straight to your chat list instead — no link to save.

## Accounts

An account keeps a chat list, so you don't need to save a personal link for every session — tap
**Create an account**, pick a username, and save the **account link** it shows you once. That link
is the only way to sign back in on another device or after clearing your browser; there's still no
password and no recovery. Once signed in, starting or joining a session adds it to your list
automatically, and the personal-link Warning no longer applies to sessions opened from an account,
since the account link already covers that.

## Chatting

Everyone in a session shares one encryption key, generated once when the session was created and
given to each participant individually as they join. Every message is encrypted with that key
before it's sent, and decrypted locally when it arrives. Anyone without an account shows up under a
short random name (like "BlueFox") instead of a real identity.

## What this protects, and what it doesn't

- **Message content is unreadable to the server and the database** — they only ever see ciphertext.
- **Which sessions exist is also hidden from anyone with just database access** — there's no
  plaintext link anywhere in storage between an identity and the sessions it belongs to, only
  encrypted records that identity's own private key can open.
- **There's no password recovery.** Your private key lives only in your personal link. Lose that
  link (or clear your browser's storage) and that session is gone for good — there's no way for
  anyone, including the app, to recover it.
- **Metadata isn't fully hidden.** That a session exists and roughly when messages were sent are
  visible at the database level even though the content and membership aren't.
- **This doesn't (yet) protect against someone intercepting the very first exchange of keys**, and
  doesn't (yet) stop someone with write access to the database from tampering with a record in ways
  a legitimate participant's app would simply reject on sight — there's no server-side check
  rejecting a forged record before it's stored. For a casual private conversation this is fine; it
  isn't the same guarantee as apps that let you verify a "safety number" with the other person out
  of band.

## Common Questions

**Q: Why is my change not showing?**

A: This is a progressive web app (PWA), which means it caches content locally to work offline. If
you deployed a new version but see an old one, try tapping "Reload latest" in the footer or opening
the app in a private/incognito tab.

**Q: Can I use this offline?**

A: The app shell works offline, but sending and receiving messages needs a connection — that's what
lets everyone stay in sync.

**Q: How do I report a bug?**

A: Take a screenshot and share it with the developer. If the footer shows a debug log (tap "View
logs"), copy it and include that too — it helps debug issues.

**Q: What data is stored, and where?**

A: Encrypted messages and encrypted per-identity access records live in a shared database
(Supabase), so devices can sync. Private keys never leave your browser — they exist only in your
personal link.

---

**Need more help?** Reach out to the developer.
