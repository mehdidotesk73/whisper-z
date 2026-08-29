// Cryptographic primitives for the capability-based session model.
//
// Everything here builds on two native Web Crypto primitives — ECDH (P-256)
// for key agreement and AES-GCM for authenticated encryption — reused for
// every purpose in the app: message content, sealed per-identity envelopes,
// and session-key wrapping. No custom elliptic-curve math, no hand-rolled
// AEAD. See docs/system-design.md §3 for how these compose into the session
// model, and docs/experience.md for the design rationale.

const ECDH_PARAMS: EcKeyImportParams | EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' }
const AES_PARAMS = { name: 'AES-GCM', length: 256 }

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']) as Promise<CryptoKeyPair>
}

export async function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key)
}

export async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key)
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, true, [])
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveKey', 'deriveBits'])
}

/** An EC private key's JWK already contains its public half (x, y) — no separate export needed. */
export function publicJwkFromPrivateJwk(jwk: JsonWebKey): JsonWebKey {
  const { kty, crv, x, y } = jwk
  return { kty, crv, x, y, ext: true, key_ops: [] }
}

/**
 * A stable identity string for a P-256 public key, for exact-match storage
 * and comparison (accounts.public_key, a message's `sender`, the encrypted
 * value inside a session_participants row). `x`/`y` are the only fields that
 * actually identify the key — JSON.stringify
 * on a whole JWK isn't safe for this, since two JWKs for the same key can
 * serialize with different field orders depending on how each was built
 * (the browser's own `exportKey` vs. `publicJwkFromPrivateJwk` above).
 */
export function canonicalPublicKeyId(jwk: JsonWebKey): string {
  return `${jwk.x}.${jwk.y}`
}

export async function deriveSharedKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, AES_PARAMS, false, [
    'encrypt',
    'decrypt',
  ])
}

export interface EncryptedPayload {
  ciphertext: string
  iv: string
}

export async function encryptText(key: CryptoKey, text: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(text)
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return { ciphertext: bufToBase64(buf), iv: bufToBase64(iv.buffer) }
}

export async function decryptText(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const ciphertext = base64ToBuf(payload.ciphertext)
  const iv = base64ToBuf(payload.iv)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext)
  return new TextDecoder().decode(plain)
}

// --- Session content key ---------------------------------------------------
// One random AES-256 key per session, generated once by whoever creates it.
// Every participant gets their own sealed copy (see sealForRecipient below);
// the key itself is never derived from anyone's identity, so adding a
// participant later never requires re-encrypting history.

export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_PARAMS, true, ['encrypt', 'decrypt'])
}

export async function exportSessionKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key)
}

export async function importSessionKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

// --- Sealed envelopes (ECIES) ------------------------------------------------
// "Seal this payload so only the holder of recipientPrivateKey can open it."
// A fresh, one-time keypair stands in for the sealer's identity — the
// sealer doesn't need a long-term keypair of their own, and the ephemeral
// private half is discarded immediately after use. This is the one
// operation every encrypted table in the schema is built from: session
// access rows, private identity state, anything sealed to a single owner.

export interface SealedEnvelope {
  ciphertext: string
  iv: string
  ephemeralPublicKey: string // packed JWK
}

export async function sealForRecipient(payload: unknown, recipientPublicKey: CryptoKey): Promise<SealedEnvelope> {
  const ephemeral = await generateKeyPair()
  const sharedKey = await deriveSharedKey(ephemeral.privateKey, recipientPublicKey)
  const { ciphertext, iv } = await encryptText(sharedKey, JSON.stringify(payload))
  const ephemeralPublicKey = packJwk(await exportPublicKey(ephemeral.publicKey))
  return { ciphertext, iv, ephemeralPublicKey }
}

export async function openSealed<T>(envelope: SealedEnvelope, recipientPrivateKey: CryptoKey): Promise<T> {
  const ephemeralPublicKey = await importPublicKey(unpackJwk(envelope.ephemeralPublicKey))
  const sharedKey = await deriveSharedKey(recipientPrivateKey, ephemeralPublicKey)
  const json = await decryptText(sharedKey, { ciphertext: envelope.ciphertext, iv: envelope.iv })
  return JSON.parse(json) as T
}

// --- Join secrets ------------------------------------------------------------
// A join link's secret is 32 random bytes used directly as a raw AES-256 key
// — both the creator (encrypting) and anyone who follows the link
// (decrypting) derive nothing, they just import the same bytes. The secret
// lives only in the URL fragment; the database never sees it, only the
// ciphertext it produces.

export function generateJoinSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

export async function importJoinKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

// --- Private lookup tags -----------------------------------------------------
// session_access and private_account_state are looked up by owner, but the
// lookup value can't be the identity's real public key — that's already
// public (it's how someone starts a session targeted at you), so using it
// as a search key would let anyone reconstruct "which sessions does this
// account have" from the outside. Instead, derive a purpose-scoped tag from
// the PRIVATE key: computable only by whoever holds it, stable across every
// session so one query finds them all, and useless to anyone who only has
// the public key.

export async function deriveLookupTag(privateKey: CryptoKey, purpose: string): Promise<string> {
  const jwk = await exportPrivateKey(privateKey)
  const scalar = base64ToBuf(urlSafeBase64ToStandard(jwk.d!))
  const input = new Uint8Array(scalar.byteLength + purpose.length)
  input.set(new Uint8Array(scalar), 0)
  input.set(new TextEncoder().encode(purpose), scalar.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return bufToBase64(digest)
}

// --- Pairwise discoverable secrets (session invites) -------------------------
// ECDH is symmetric: ECDH(A_priv, B_pub) === ECDH(B_priv, A_pub). Both public
// keys are already published (accounts.public_key), so two accounts can
// independently derive the identical secret — no ephemeral keypair, no
// lookup step, no prior exchange beyond however A obtained B's public key
// (e.g. physically, out of band). Whoever's key is the target of a search
// (the invitee) tries this against candidate accounts to find a match by an
// indexed tag comparison, never a full-table decrypt-and-see. See
// docs/system-design.md §3 for the full session_invites design and why a
// username-lookup-based version of this was rejected.

export async function derivePairwiseSecret(privateKey: CryptoKey, otherPublicKey: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits({ name: 'ECDH', public: otherPublicKey }, privateKey, 256)
}

function purposeTaggedInput(secret: ArrayBuffer, purpose: string): Uint8Array {
  const input = new Uint8Array(secret.byteLength + purpose.length)
  input.set(new Uint8Array(secret), 0)
  input.set(new TextEncoder().encode(purpose), secret.byteLength)
  return input
}

/** A stable, indexable tag for a pairwise secret — computable by either side, useless to anyone else. */
export async function derivePairwiseTag(secret: ArrayBuffer, purpose: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', purposeTaggedInput(secret, purpose))
  return bufToBase64(digest)
}

/** A symmetric key for encrypting payloads addressed via a pairwise secret — separate purpose string from the tag. */
export async function derivePairwiseKey(secret: ArrayBuffer, purpose: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest('SHA-256', purposeTaggedInput(secret, purpose))
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

// --- Encoding helpers ---------------------------------------------------------

function bufToBase64(buf: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function urlSafeBase64ToStandard(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return b64
}

/** Packs any JSON-serializable value into a URL-safe string, for a link fragment. */
export function packJwk(jwk: JsonWebKey): string {
  return btoa(JSON.stringify(jwk)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unpackJwk(packed: string): JsonWebKey {
  return JSON.parse(atob(urlSafeBase64ToStandard(packed)))
}

export function bytesToUrlSafe(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function urlSafeToBytes(packed: string): Uint8Array {
  const binary = atob(urlSafeBase64ToStandard(packed))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
