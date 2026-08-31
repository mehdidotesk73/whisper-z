// Cryptographic primitives for the capability-based session model.
//
// Everything here builds on two native Web Crypto primitives — ECDH (P-256)
// for key agreement and AES-GCM for authenticated encryption — reused for
// every purpose in the app: message content, sealed per-identity envelopes,
// and session-key wrapping. No custom elliptic-curve math, no hand-rolled
// AEAD. See docs/system-design.md §3 for how these compose into the session
// model, and docs/experience.md for the design rationale.

const ECDH_PARAMS: EcKeyImportParams | EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' }
const ECDSA_PARAMS: EcKeyImportParams | EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' }
const AES_PARAMS = { name: 'AES-GCM', length: 256 }
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

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

/**
 * Strips `key_ops` before importing: a JWK exported before `deriveBits` was
 * added to `generateKeyPair` (every account/guest identity created before
 * this feature) carries `key_ops: ['deriveKey']` only, and WebCrypto's JWK
 * import rejects a request for any usage not already listed there —
 * `key_ops` here is bookkeeping we ourselves attached at export time, not a
 * real cryptographic restriction (the key material doesn't care), so this
 * is safe to relax on our own read path. Without this, every identity
 * created before this branch fails to log back in at all.
 */
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const { key_ops: _key_ops, ...rest } = jwk
  return crypto.subtle.importKey('jwk', rest, ECDH_PARAMS, true, ['deriveKey', 'deriveBits'])
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

/** Reverses canonicalPublicKeyId — reconstructs an importable public JWK from an accounts.public_key id string. */
export function publicKeyFromCanonicalId(id: string): JsonWebKey {
  const [x, y] = id.split('.')
  return { kty: 'EC', crv: 'P-256', x, y, ext: true, key_ops: [] }
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

// --- Signing (ECDSA P-256) ---------------------------------------------------
// Two different origins for a signing keypair, for two different reasons —
// see docs/system-design.md §3's "Stage E" entry for the full rationale.
//
// 1. An admin signing keypair is freshly GENERATED, once, at session
//    creation — same reasoning as the admin ECDH keypair (generateKeyPair
//    above, reused as-is): a session's admin authority must be a property of
//    that session, not derivable from anything about the creator's real
//    identity.
// 2. Every identity's own personal signing keypair is DERIVED from its
//    existing ECDH private key, not generated independently — see
//    derivePersonalSigningKeyPair below.
//
// Both produce an ordinary ECDSA CryptoKey; signData/verifySignature work on
// either without caring which.

export async function generateAdminSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

/** Strips key_ops for the same reason importPrivateKey does — publicJwkFromPrivateJwk sets it to [], which mismatches a ['verify'] usage request. */
export async function importEcdsaPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const { key_ops: _key_ops, ...rest } = jwk
  return crypto.subtle.importKey('jwk', rest, ECDSA_PARAMS, true, ['verify'])
}

/** Same key_ops-stripping as importPrivateKey above — this app's own exports are the only source, so it's safe to relax on our own read path. */
export async function importEcdsaPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const { key_ops: _key_ops, ...rest } = jwk
  return crypto.subtle.importKey('jwk', rest, ECDSA_PARAMS, true, ['sign'])
}

export async function signData(privateKey: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(data))
  return bufToBase64(sig)
}

export async function verifySignature(publicKey: CryptoKey, signature: string, data: string): Promise<boolean> {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64ToBuf(signature),
    new TextEncoder().encode(data),
  )
}

// --- Personal signing keypair, derived rather than generated -----------------
// A message's `sender` field is otherwise just a self-reported string with
// nothing binding it to the identity it names — any participant holding the
// shared session key could write a message claiming to be anyone else. This
// closes that: every identity gets a signing keypair derived from its
// existing ECDH private key (SHA-256(ecdhPrivateKeyBytes || purpose), reduced
// mod the curve order, used directly as the ECDSA private scalar) rather than
// generated independently — see docs/system-design.md §3 for why deriving
// matters (a personal/account/guest link only ever carries one private key;
// generating a second, independent signing key would mean the link needs to
// carry two just to be that identity somewhere new).
//
// WebCrypto has no "compute a public key from a raw scalar" operation — it
// only generates fresh random keypairs, or imports ones where the public
// point is already known and gets checked for consistency with the private
// scalar. PKCS8's ECPrivateKey structure (RFC 5915) has an OPTIONAL public-key
// field, though, and importing one with that field omitted makes the browser
// derive and attach the matching public key itself. Verified directly against
// Chromium (not just Node) before relying on it: import succeeds, the key
// signs, and the exported public half correctly verifies that signature — see
// "Deriving an ECDSA Keypair From a Raw Scalar" in docs/experience.md for the
// verification script and the one open risk this doesn't close (unconfirmed
// on Safari/WebKit, this app's actual mobile target).
const PERSONAL_SIGNING_PURPOSE = 'personal-signing'

function reduceModOrder(digest: Uint8Array, order: bigint): bigint {
  let n = 0n
  for (const byte of digest) n = (n << 8n) | BigInt(byte)
  n = n % order
  return n === 0n ? 1n : n // 0 isn't a valid private scalar; astronomically unlikely, defensive only
}

function bigIntToFixedBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let n = value
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return bytes
}

/** Minimal DER encoders — just enough ASN.1 to build the one PKCS8 shape below, nothing general-purpose. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}
function derSequence(contents: number[][]): number[] {
  const body = contents.flat()
  return [0x30, ...derLength(body.length), ...body]
}
function derOctetString(bytes: number[]): number[] {
  return [0x04, ...derLength(bytes.length), ...bytes]
}
function derSmallInt(n: number): number[] {
  return [0x02, ...derLength(1), n]
}
function derOid(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return [0x06, ...derLength(bytes.length), ...bytes]
}

const EC_PUBLIC_KEY_OID = '2a8648ce3d0201' // 1.2.840.10045.2.1
const P256_OID = '2a8648ce3d030107' // 1.2.840.10045.3.1.7

/** Builds a PKCS8 PrivateKeyInfo for a raw P-256 scalar, deliberately omitting ECPrivateKey's optional public-key field — see the comment above. */
function pkcs8FromP256Scalar(scalarBytes: Uint8Array): Uint8Array {
  const ecPrivateKey = derSequence([derSmallInt(1), derOctetString([...scalarBytes])])
  const algorithmId = derSequence([derOid(EC_PUBLIC_KEY_OID), derOid(P256_OID)])
  const pkcs8 = derSequence([derSmallInt(0), algorithmId, derOctetString(ecPrivateKey)])
  return new Uint8Array(pkcs8)
}

export async function derivePersonalSigningKeyPair(ecdhPrivateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await exportPrivateKey(ecdhPrivateKey)
  const scalar = base64ToBuf(urlSafeBase64ToStandard(jwk.d!))
  const purposeBytes = new TextEncoder().encode(PERSONAL_SIGNING_PURPOSE)
  const input = new Uint8Array(scalar.byteLength + purposeBytes.length)
  input.set(new Uint8Array(scalar), 0)
  input.set(purposeBytes, scalar.byteLength)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))

  const derivedScalar = bigIntToFixedBytes(reduceModOrder(digest, P256_ORDER), 32)
  const pkcs8 = pkcs8FromP256Scalar(derivedScalar)
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDSA_PARAMS, true, ['sign'])
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

/**
 * A capability (Stage E) is the exact same one-way derivation deriveLookupTag
 * already does — SHA-256(privateKey || purpose) — aliased under its own name
 * because here the result IS the usable secret being granted, not a value
 * used to search a table. Admin derives any capability on demand from
 * adminEcdhPrivateKey and never stores one; see docs/system-design.md §3's
 * "Stage E" entry for the full capability-grant design.
 */
export async function deriveCapability(adminEcdhPrivateKey: CryptoKey, purpose: string): Promise<string> {
  return deriveLookupTag(adminEcdhPrivateKey, purpose)
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
