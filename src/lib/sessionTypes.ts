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
  text: string
  createdAt: string
}
