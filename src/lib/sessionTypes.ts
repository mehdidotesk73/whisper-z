// Shapes of the payloads sealed inside session_access and join_access rows.
// Pure types — no logic, no I/O.

export interface SessionAccessPayload {
  sessionId: string
  sessionKey: JsonWebKey
  role: 'owner' | 'member'
  title?: string
  /**
   * Present only when this access row is an account's migrated copy of a
   * guest session (see api/sessionActions.ts migrateGuestSessionToAccount).
   * The account keeps presenting as this original guest public key for this
   * one session, so old messages (sender = this id, baked in at encryption
   * time and immutable) and new ones resolve to the same participant row
   * with zero special-casing in the render path.
   */
  identityPublicKeyId?: string
}

export interface JoinPayload {
  sessionId: string
  sessionKey: JsonWebKey
}

export interface DecodedMessage {
  sender: string
  /**
   * The sender's own best-known name for themselves, baked in at send time
   * by the sending client — not resolved later from session_participants.
   * This is what lets a migrated guest identity's later messages show the
   * account's current username to everyone else, while earlier messages
   * (sent before any account existed) keep showing whatever name was true
   * then: each message is a frozen, self-reported snapshot, the same way
   * session_participants.display_name already is — no new trust
   * assumption, no new table, no re-resolving after the fact.
   */
  senderName: string
  text: string
  createdAt: string
}
