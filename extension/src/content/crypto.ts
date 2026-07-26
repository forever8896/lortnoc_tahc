// Client-side crypto — runs ONLY in the content script (in-page). Plaintext and key
// never leave here (invariant §4). AES-SIV's auth tag doubles as the "is this ours?"
// detector: decrypt throws on tag mismatch.
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { x25519 } from '@noble/curves/ed25519.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---- Keying: X25519 ECDH, exchanged in-band as cover text (§5.3 Tier 1) ----
//
// There is deliberately no passphrase path. A second way to key a chat meant the two sides
// could silently choose differently, and each would then read only its own messages.

export type KeyPair = { priv: Uint8Array; pub: Uint8Array }

/** Fresh ephemeral X25519 keypair for one conversation. */
export function genKeyPair(): KeyPair {
  const priv = crypto.getRandomValues(new Uint8Array(32)) // valid x25519 scalar
  return { priv, pub: x25519.getPublicKey(priv) }
}

const ECDH_SALT = enc.encode('lortnoc/conv/x25519/v1')

/**
 * K_conv from ECDH — identical on both ends by symmetry, no secret transmitted.
 * The HKDF info binds both pubkeys (sorted) so both derive the same value regardless
 * of who was offer vs ack.
 */
export function deriveConvKey(myPriv: Uint8Array, theirPub: Uint8Array, myPub: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myPriv, theirPub)
  const [a, b] = [myPub, theirPub].sort(cmpBytes)
  const info = new Uint8Array(a.length + b.length)
  info.set(a, 0)
  info.set(b, a.length)
  return hkdf(sha256, shared, ECDH_SALT, info, 64)
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

export function encrypt(key: Uint8Array, plaintext: string): Uint8Array {
  return aessiv(key).encrypt(enc.encode(plaintext))
}

/** Returns the decoded message, or null if the tag doesn't verify (not one of ours). */
export function tryDecrypt(key: Uint8Array, ciphertext: Uint8Array): string | null {
  try {
    return dec.decode(aessiv(key).decrypt(ciphertext))
  } catch {
    return null
  }
}

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}
