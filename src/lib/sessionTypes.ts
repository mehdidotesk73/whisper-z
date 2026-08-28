// Shapes of the payloads sealed inside session_access and join_access rows.
// Pure types — no logic, no I/O.

export interface SessionAccessPayload {
  sessionId: string
  sessionKey: JsonWebKey
  role: 'owner' | 'member'
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
