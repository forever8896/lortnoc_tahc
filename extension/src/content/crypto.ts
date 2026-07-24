// Client-side crypto — runs ONLY in the content script (in-page). Plaintext and key
// never leave here (invariant §4). AES-SIV's auth tag doubles as the "is this ours?"
// detector: decrypt throws on tag mismatch.
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

// Fixed domain string so both parties derive the SAME key from the SAME passphrase.
// (Per-conversation keying via ECDH is CLAUDE.md §5.3 — a later tier; the demo uses a
// pre-shared passphrase, so the scope is constant on purpose.)
const SALT = enc.encode('lortnoc/conv/aes-siv/v1')
const INFO = enc.encode('demo')

/** K_conv = HKDF-SHA256(passphrase). 64 bytes → AES-256-SIV. */
export function deriveKey(passphrase: string): Uint8Array {
  return hkdf(sha256, enc.encode(passphrase), SALT, INFO, 64)
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
