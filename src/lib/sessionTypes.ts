// Shapes of the payloads sealed inside session_access and join_access rows.
// Pure types — no logic, no I/O.

export interface SessionAccessPayload {
  sessionId: string
  sessionKey: JsonWebKey
  role: 'owner' | 'member'
  title?: string
  /**
   * Guest public keys this account has merged into this session (see
   * api/sessionActions.ts migrateGuestSessionToAccount) — one entry per
   * guest identity migrated in, since an account can hold this session both
   * from a direct join under its own key AND from migrating one or more
   * earlier guest visits into it. Old messages were sent under these
   * original guest keys (baked in at encryption time, immutable) — this is
   * a private hint, decryptable only by the account itself, letting its own
   * client still recognize those old messages as "mine" for bubble styling.
   * It plays no part in what anyone else sees: a message's sender NAME is
   * resolved independently (see DecodedMessage below), purely from
   * whichever public key actually sent it, live against the `accounts`
   * table — an account's real key resolves to its real (and current)
   * username, a pinned guest key never will.
   */
  identityPublicKeyIds?: string[]
}

export interface JoinPayload {
  sessionId: string
  sessionKey: JsonWebKey
}

export interface DecodedMessage {
  sender: string
  text: string
  createdAt: string
}
