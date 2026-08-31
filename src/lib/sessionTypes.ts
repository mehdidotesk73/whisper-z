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
  /**
   * The session's admin ECDH + signing PUBLIC keys (Stage E) — present on
   * every participant's row, however they joined, so anyone can verify an
   * admin-signed session_log entry. Absent on a session created before this
   * feature shipped; see docs/system-design.md §3's "Stage E" entry and
   * lib/crypto.ts's admin-signing-keypair section.
   */
  adminEcdhPublicKey?: JsonWebKey
  adminSigningPublicKey?: JsonWebKey
  /**
   * The admin keypairs' PRIVATE halves — present only on the session
   * creator's own row, sealed to nobody else, never forwarded into anyone
   * else's payload. Whoever holds these can derive any capability on demand
   * (lib/crypto.ts deriveLookupTag reused for that purpose) and sign as
   * admin.
   */
  adminEcdhPrivateKey?: JsonWebKey
  adminSigningPrivateKey?: JsonWebKey
}

export interface JoinPayload {
  sessionId: string
  sessionKey: JsonWebKey
  /** Forwarded from the inviter's own SessionAccessPayload — see the admin key fields above. Absent for a session created before Stage E. */
  adminEcdhPublicKey?: JsonWebKey
  adminSigningPublicKey?: JsonWebKey
}

/**
 * What a session_participants row now decrypts to (Stage E) — a bare
 * public-key-id string, same as before, plus that identity's personal
 * signing public key so fellow participants can verify their messages. A
 * row written before this feature shipped decrypts to just the bare string,
 * not this shape — every reader must handle both (see
 * api/sessionActions.ts's parseParticipantPayload).
 */
export interface ParticipantPayload {
  publicKeyId: string
  signingPublicKey: JsonWebKey
}

export interface DecodedMessage {
  sender: string
  text: string
  createdAt: string
  /**
   * `kind`/`signature` are absent on any message sent before Stage E
   * shipped — that's a legacy shape, not a malformed one, and it's still
   * rendered and trusted exactly as it always was; nothing about this
   * feature retroactively distrusts history it can't verify. Present and
   * checked against the sender's signing key (from ParticipantPayload
   * above) for anything sent from here on. See "Signing Is Opportunistic,
   * Not Yet Enforced" in docs/experience.md for the honest limit this
   * leaves open during the transition.
   */
  kind?: 'message'
  signature?: string
}
