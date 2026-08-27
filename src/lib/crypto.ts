// Key agreement (ECDH) + symmetric encryption (AES-GCM) for the chat.
//
// Each participant has a keypair generated locally. Combining your private
// key with the other side's public key produces the same shared secret as
// they get combining theirs with yours — that shared secret becomes the
// AES-GCM key. Private keys never leave this module's caller; only public
// keys and ciphertext are ever handed to the database. See "End-to-End
// Encryption Over a Database You Don't Trust" in docs/experience.md.

const ECDH_PARAMS: EcKeyImportParams | EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' }

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey']) as Promise<CryptoKeyPair>
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
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveKey'])
}

export async function deriveSharedKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
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

/**
 * Wraps a chat's private key so an account can hold it in the database.
 * Reuses the same ECDH+AES-GCM primitives above, applied to "a key" instead
 * of "a message" — the wrap key is `deriveSharedKey(myPrivateKey,
 * theirPublicKey)`, computable by either side of that pair. Called at
 * attach time with the chat's own freshly-generated keypair as `myPrivateKey`
 * and the account's public key as `theirPublicKey`.
 */
export async function wrapPrivateKey(
  keyToWrap: JsonWebKey,
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<EncryptedPayload> {
  const wrapKey = await deriveSharedKey(myPrivateKey, theirPublicKey)
  return encryptText(wrapKey, JSON.stringify(keyToWrap))
}

/**
 * Reverses `wrapPrivateKey`. Called with the account's own private key as
 * `myPrivateKey` and the chat's own public key (already public, sitting on
 * the session row) as `theirPublicKey` — the ECDH symmetry means this
 * recovers the same wrap key without the account ever seeing the chat's
 * private key over the wire.
 */
export async function unwrapPrivateKey(
  payload: EncryptedPayload,
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<JsonWebKey> {
  const wrapKey = await deriveSharedKey(myPrivateKey, theirPublicKey)
  const json = await decryptText(wrapKey, payload)
  return JSON.parse(json)
}

/** Pack a JWK into a URL-safe string, for embedding a private key in a link fragment. */
export function jwkToUrlSafe(jwk: JsonWebKey): string {
  return btoa(JSON.stringify(jwk)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function urlSafeToJwk(packed: string): JsonWebKey {
  let b64 = packed.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return JSON.parse(atob(b64))
}
