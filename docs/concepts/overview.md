# About whisper-z

An end-to-end encrypted chat between two people. Messages are encrypted in your browser before
they're ever stored — not the server, not the database, only the two of you can read them.

## Starting a chat

Tap **Start a chat**. Your browser generates a private/public keypair on the spot — nothing is
typed in, nothing is sent anywhere except the public half. You'll get two links:

- **Your personal link** — carries your private key. Save it (bookmark it, message it to yourself)
  so you can reopen this same conversation later on this device.
- **Invite link** — send this to the other person so they can join.

## Joining a chat

Open the invite link you were sent and tap **Join chat**. This generates your own keypair the same
way, registers your public key into the conversation, and gives you your own personal link to save.

## Chatting

Once both people have joined, the app combines your private key with their public key (and they do
the same with theirs) to arrive at one shared key that only the two of you can compute — this is
standard Diffie-Hellman key exchange. Every message is encrypted with that key before it's sent, and
decrypted locally when it arrives. Until the other person joins, you'll see "waiting for the other
person to join."

## What this protects, and what it doesn't

- **Message content is unreadable to the server and the database** — they only ever see ciphertext.
- **There's no password recovery.** Your private key lives only in your personal link. Lose that
  link (or clear your browser's storage) and that conversation is gone for good — there's no way
  for anyone, including the app, to recover it.
- **Metadata isn't hidden.** That a conversation exists, and roughly when messages were sent, are
  visible at the database level even though the content isn't.
- **This doesn't (yet) protect against someone intercepting the very first exchange of keys.** For
  a casual private conversation this is fine; it isn't the same guarantee as apps that let you
  verify a "safety number" with the other person out of band.

## Common Questions

**Q: Why is my change not showing?**

A: This is a progressive web app (PWA), which means it caches content locally to work offline. If
you deployed a new version but see an old one, try tapping "Reload latest" in the footer or opening
the app in a private/incognito tab.

**Q: Can I use this offline?**

A: The app shell works offline, but sending and receiving messages needs a connection — that's what
lets both sides stay in sync.

**Q: How do I report a bug?**

A: Take a screenshot and share it with the developer. If the footer shows a debug log (tap "View
logs"), copy it and include that too — it helps debug issues.

**Q: What data is stored, and where?**

A: Encrypted messages and each side's public key live in a shared database (Supabase), so both
devices can sync. Private keys never leave your browser — they exist only in your personal link.

---

**Need more help?** Reach out to the developer.
