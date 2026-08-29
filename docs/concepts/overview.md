# About whisper-z

An end-to-end encrypted messaging app. Messages are encrypted in your browser before they're ever
stored — not the server, not the database, only the people in a session can read them.

## Starting a session

Tap **Start a session**. Your browser generates a keypair and a random key for that session on the
spot — nothing is typed in, nothing sent anywhere except what's needed to invite others. The
session opens immediately: you can start typing right away, even before anyone else has joined.

From inside the session:
- **Invite** reveals a link you can send to someone so they can join. It works once and expires
  after 10 minutes — tap **New link, for another person** to invite someone else.
- **Invite by key** adds someone directly if they already have an account and you have their public
  key — get it from them in person, or however you already trust each other (their account's **My
  public key** shows a copyable version). No link to send; they'll see it waiting for them next time
  they open their account. Right after sending, you'll see **Undo** — that only works while you're
  still on this screen; refresh or navigate away and there's nothing left to undo.
- **+ Add to account** (only shown if you joined as a guest) adds this session to an account's chat
  list — either your own, if you're signed in, or one you sign into on the spot by pasting its
  account link. Nothing about the session or its history changes; this just gives you a second way
  to reach it, so you don't have to keep guarding the personal link.
- **Adopt an alias** (only shown when viewing from your account) does the same thing from the other
  direction — paste a guest identity's private key (the one its own ⚠ Warning button reveals) to
  recognize it as you in this session, without switching over to that guest link first.
- **Logged in as `<username>`** (only shown when viewing from your account) shows which senders in
  *this* session are secretly also you, once you've adopted any aliases into it.
- **⚠ Warning** reveals your **personal link** — save it (bookmark it, message it to yourself) so
  you can reopen this exact session later on this device. Closing the tab without saving it means
  losing access for good; there's no password and no recovery. Once a session has been added to an
  account, this stops applying to it — the account link already covers recovery.

## Joining a session

Open the invite link you were sent. If you're already signed in to an account, you'll see **Join as
&lt;your username&gt;** — tap it and the session is added straight to your chat list, no link to
save. If you're not signed in, you get a choice:
- **Join as guest** generates a fresh keypair in this browser and adds you to the conversation —
  you'll land in the same thread, with your own personal link available the same way.
- **Join as existing user** lets you paste your account link on the spot to sign in, then joins
  with that account — handy when you're on a device you haven't logged into yet.

## Accounts

An account keeps a chat list, so you don't need to save a personal link for every session — tap
**Create an account**, pick a username, and save the **account link** it shows you once. That link
is the only way to sign back in on another device or after clearing your browser; there's still no
password and no recovery. To sign back in, tap **Log in** on the home screen and paste that link —
any origin (a preview link works the same as the production one) — or just the key itself, no link
needed. Once signed in, starting or joining a session adds it to your list
automatically, and the personal-link Warning no longer applies to sessions opened from an account,
since the account link already covers that. Your chat list is sorted by whichever session had a
message most recently.

**My public key**, shown on your account's home screen, is a copyable blob of your public key — safe
to share openly with anyone. Give it to someone in person (or however you already trust them) so
they can use **Invite by key** to add you to a session directly, no link required. If someone's sent
you one, you'll see it as a pending invite on your account home the next time you open it — **Accept**
joins the session immediately, **Reject** just discards it.

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
  doesn't (yet) stop someone with write access to the database from tampering with, or deleting, a
  record — there's no server-side check rejecting a forged record before it's stored, or verifying
  who's allowed to remove one. For a casual private conversation this is fine; it isn't the same
  guarantee as apps that let you verify a "safety number" with the other person out of band.
- **This protects what's stored, not network traffic.** Someone who can see requests reaching the
  server (the hosting operator, or anyone watching network traffic to it) can still notice patterns
  like "this connection repeatedly checks the same chat list" or "these two connections keep touching
  the same session" — even though they can't read any of it. If a connection is ever tied to a real
  identity through something outside the app (a signup record, a WiFi login sheet), that can connect
  backwards to everything it's ever done here. A VPN or Tor is the real mitigation for this, if it
  matters to you — that's a choice you make outside the app, not something it can provide for you.

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
