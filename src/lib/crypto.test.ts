import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importPrivateKey,
  publicJwkFromPrivateJwk,
  canonicalPublicKeyId,
  publicKeyFromCanonicalId,
  importPublicKey,
  sealForRecipient,
  openSealed,
  deriveLookupTag,
  derivePairwiseSecret,
  derivePairwiseTag,
  derivePairwiseKey,
  encryptText,
  decryptText,
  packJwk,
  unpackJwk,
  bytesToUrlSafe,
  urlSafeToBytes,
  generateAdminSigningKeyPair,
  importEcdsaPublicKey,
  importEcdsaPrivateKey,
  signData,
  verifySignature,
  derivePersonalSigningKeyPair,
} from './crypto'

describe('publicJwkFromPrivateJwk + canonicalPublicKeyId', () => {
  it('derives the same public key the browser would export, and the same id regardless of field order', async () => {
    const pair = await generateKeyPair()
    const privateJwk = await exportPrivateKey(pair.privateKey)
    const derivedPublic = publicJwkFromPrivateJwk(privateJwk)
    const nativePublic = await exportPublicKey(pair.publicKey)

    expect(derivedPublic.x).toBe(nativePublic.x)
    expect(derivedPublic.y).toBe(nativePublic.y)

    // Regression test: canonicalPublicKeyId used to compare via
    // JSON.stringify(jwk), which broke because publicJwkFromPrivateJwk's
    // hand-built object and the browser's native exportKey serialize their
    // fields in different orders for the same key. Only x/y should matter.
    expect(canonicalPublicKeyId(derivedPublic)).toBe(canonicalPublicKeyId(nativePublic))
  })

  it('round-trips through publicKeyFromCanonicalId back to an importable key', async () => {
    const pair = await generateKeyPair()
    const publicJwk = await exportPublicKey(pair.publicKey)
    const id = canonicalPublicKeyId(publicJwk)
    const reconstructed = publicKeyFromCanonicalId(id)
    const imported = await importPublicKey(reconstructed)
    expect(canonicalPublicKeyId(await exportPublicKey(imported))).toBe(id)
  })
})

describe('importPrivateKey', () => {
  it('imports a legacy JWK whose key_ops only lists deriveKey (every identity created before deriveBits was added)', async () => {
    const pair = await generateKeyPair()
    const jwk = await exportPrivateKey(pair.privateKey)

    // Simulate an old export: WebCrypto's own exportKey would have written
    // key_ops matching whatever usages the key was generated with at the
    // time. Before deriveBits was added to generateKeyPair, that was just
    // ['deriveKey'] — reproduce that exact shape.
    const legacyJwk: JsonWebKey = { ...jwk, key_ops: ['deriveKey'] }

    const imported = await importPrivateKey(legacyJwk)

    // The regression this guards: WebCrypto's JWK import rejects a request
    // for any usage not already listed in the JWK's own key_ops. Confirm the
    // recovered key actually supports deriveBits (needed for pairwise
    // invites), not just that import didn't throw.
    const otherPair = await generateKeyPair()
    await expect(derivePairwiseSecret(imported, otherPair.publicKey)).resolves.toBeInstanceOf(ArrayBuffer)
  })
})

describe('sealForRecipient / openSealed', () => {
  it('round-trips a payload for the intended recipient', async () => {
    const recipient = await generateKeyPair()
    const payload = { sessionId: 'abc-123', role: 'owner' }

    const envelope = await sealForRecipient(payload, recipient.publicKey)
    const opened = await openSealed<typeof payload>(envelope, recipient.privateKey)

    expect(opened).toEqual(payload)
  })

  it('fails for anyone other than the intended recipient', async () => {
    const recipient = await generateKeyPair()
    const stranger = await generateKeyPair()
    const envelope = await sealForRecipient({ secret: 'value' }, recipient.publicKey)

    await expect(openSealed(envelope, stranger.privateKey)).rejects.toThrow()
  })
})

describe('deriveLookupTag', () => {
  it('is stable for the same identity and purpose', async () => {
    const pair = await generateKeyPair()
    const tag1 = await deriveLookupTag(pair.privateKey, 'session-access')
    const tag2 = await deriveLookupTag(pair.privateKey, 'session-access')
    expect(tag1).toBe(tag2)
  })

  it('differs across purposes for the same identity', async () => {
    const pair = await generateKeyPair()
    const sessionAccessTag = await deriveLookupTag(pair.privateKey, 'session-access')
    const otherTag = await deriveLookupTag(pair.privateKey, 'something-else')
    expect(sessionAccessTag).not.toBe(otherTag)
  })

  it('differs across identities for the same purpose', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const tagA = await deriveLookupTag(a.privateKey, 'session-access')
    const tagB = await deriveLookupTag(b.privateKey, 'session-access')
    expect(tagA).not.toBe(tagB)
  })
})

describe('pairwise discoverable secrets (session invites)', () => {
  it('DH reciprocity: both sides derive the identical secret, tag, and usable key', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()

    const secretFromA = await derivePairwiseSecret(a.privateKey, b.publicKey)
    const secretFromB = await derivePairwiseSecret(b.privateKey, a.publicKey)
    expect(new Uint8Array(secretFromA)).toEqual(new Uint8Array(secretFromB))

    const tagFromA = await derivePairwiseTag(secretFromA, 'session-invite-tag')
    const tagFromB = await derivePairwiseTag(secretFromB, 'session-invite-tag')
    expect(tagFromA).toBe(tagFromB)

    const keyFromA = await derivePairwiseKey(secretFromA, 'session-invite-key')
    const keyFromB = await derivePairwiseKey(secretFromB, 'session-invite-key')
    const sealed = await encryptText(keyFromA, 'hello invitee')
    expect(await decryptText(keyFromB, sealed)).toBe('hello invitee')
  })

  it('an uninvolved third party cannot reproduce the tag or decrypt', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const stranger = await generateKeyPair()

    const realSecret = await derivePairwiseSecret(a.privateKey, b.publicKey)
    const realTag = await derivePairwiseTag(realSecret, 'session-invite-tag')

    const strangerSecret = await derivePairwiseSecret(stranger.privateKey, b.publicKey)
    const strangerTag = await derivePairwiseTag(strangerSecret, 'session-invite-tag')

    expect(strangerTag).not.toBe(realTag)

    const realKey = await derivePairwiseKey(realSecret, 'session-invite-key')
    const strangerKey = await derivePairwiseKey(strangerSecret, 'session-invite-key')
    const sealed = await encryptText(realKey, 'secret payload')
    await expect(decryptText(strangerKey, sealed)).rejects.toThrow()
  })
})

describe('packJwk / unpackJwk and byte encoding round trips', () => {
  it('round-trips a JWK through the URL-safe packed form', async () => {
    const pair = await generateKeyPair()
    const jwk = await exportPrivateKey(pair.privateKey)
    const packed = packJwk(jwk)

    expect(packed).not.toMatch(/[+/=]/) // URL-safe: no raw base64 chars that need escaping in a hash fragment
    expect(unpackJwk(packed)).toEqual(jwk)
  })

  it('round-trips raw bytes through the URL-safe encoding (join secrets)', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const packed = bytesToUrlSafe(bytes)
    expect(packed).not.toMatch(/[+/=]/)
    expect(urlSafeToBytes(packed)).toEqual(bytes)
  })
})

describe('signData / verifySignature', () => {
  it('a freshly generated admin signing keypair signs and verifies', async () => {
    const pair = await generateAdminSigningKeyPair()
    const signature = await signData(pair.privateKey, 'hello world')
    await expect(verifySignature(pair.publicKey, signature, 'hello world')).resolves.toBe(true)
  })

  it('rejects a tampered message', async () => {
    const pair = await generateAdminSigningKeyPair()
    const signature = await signData(pair.privateKey, 'hello world')
    await expect(verifySignature(pair.publicKey, signature, 'goodbye world')).resolves.toBe(false)
  })

  it('rejects a signature from an impostor key', async () => {
    const real = await generateAdminSigningKeyPair()
    const impostor = await generateAdminSigningKeyPair()
    const signature = await signData(impostor.privateKey, 'hello world')
    await expect(verifySignature(real.publicKey, signature, 'hello world')).resolves.toBe(false)
  })

  it('round-trips a generated keypair through JWK export/import', async () => {
    const pair = await generateAdminSigningKeyPair()
    const privateJwk = await exportPrivateKey(pair.privateKey)
    const publicJwk = await exportPublicKey(pair.publicKey)
    const importedPrivate = await importEcdsaPrivateKey(privateJwk)
    const importedPublic = await importEcdsaPublicKey(publicJwk)

    const signature = await signData(importedPrivate, 'hello world')
    await expect(verifySignature(importedPublic, signature, 'hello world')).resolves.toBe(true)
  })
})

describe('derivePersonalSigningKeyPair', () => {
  it('derives a signing key that signs and verifies against its own exported public half', async () => {
    const identity = await generateKeyPair()
    const signingKey = await derivePersonalSigningKeyPair(identity.privateKey)

    const signature = await signData(signingKey, 'a message')
    const exported = await exportPrivateKey(signingKey) // includes the browser-computed x/y — see crypto.ts's comment on the PKCS8 trick
    const publicKey = await importEcdsaPublicKey(publicJwkFromPrivateJwk(exported))

    await expect(verifySignature(publicKey, signature, 'a message')).resolves.toBe(true)
  })

  it('is stable for the same identity and purpose', async () => {
    const identity = await generateKeyPair()
    const first = await derivePersonalSigningKeyPair(identity.privateKey)
    const second = await derivePersonalSigningKeyPair(identity.privateKey)

    expect(await exportPrivateKey(first)).toEqual(await exportPrivateKey(second))
  })

  it('differs across identities', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const signingA = await derivePersonalSigningKeyPair(a.privateKey)
    const signingB = await derivePersonalSigningKeyPair(b.privateKey)

    expect(await exportPrivateKey(signingA)).not.toEqual(await exportPrivateKey(signingB))
  })

  it("a signature from one identity's derived key does not verify against another's", async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const signingA = await derivePersonalSigningKeyPair(a.privateKey)
    const signingB = await derivePersonalSigningKeyPair(b.privateKey)

    const signature = await signData(signingA, 'a message')
    const exportedB = await exportPrivateKey(signingB)
    const publicB = await importEcdsaPublicKey(publicJwkFromPrivateJwk(exportedB))

    await expect(verifySignature(publicB, signature, 'a message')).resolves.toBe(false)
  })
})
