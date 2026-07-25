// Client-side crypto — runs ONLY in the content script (in-page). Plaintext and key
// never leave here (invariant §4). AES-SIV's auth tag doubles as the "is this ours?"
// detector: decrypt throws on tag mismatch.
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { x25519 } from '@noble/curves/ed25519.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

// Fixed domain string so both parties derive the SAME key from the SAME passphrase.
const SALT = enc.encode('lortnoc/conv/aes-siv/v1')
const INFO = enc.encode('demo')

/** K_conv = HKDF-SHA256(passphrase). 64 bytes → AES-256-SIV. (Fallback keying.) */
export function deriveKey(passphrase: string): Uint8Array {
  return hkdf(sha256, enc.encode(passphrase), SALT, INFO, 64)
}

// ---- Tier-1 in-band handshake: passphrase-free keying via X25519 ECDH (§5.3) ----

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
