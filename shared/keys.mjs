// The CLAUDE.md §5.1 key-derivation table. ONE implementation, imported by the extension,
// the web app, the CLI and the relayer.
//
// Before this file existed the table was hand-inlined in six places across three workspaces:
// extension/src/content/crypto.ts, app/src/lib/crypto.ts, scripts/ens/derive.mjs,
// app/src/lib/live/proof.ts, app/src/lib/live/membership.ts, app/src/lib/live.ts and
// scripts/ens/membership.mjs. They agreed, but nothing made them agree, and every failure
// mode of a disagreement is silent:
//
//   * K_conv drifts  → each surface reads only its own messages (§3 "one key set" broken)
//   * id_sem drifts  → the proof is generated against a commitment nobody ever paid for
//                      (proof.ts said so itself: "Must match membership.ts::commitmentFrom
//                      exactly")
//   * K_own drifts   → the CLI addresses a different owner than the browser derives, and the
//                      handle is minted to an address nobody holds
//
// None of those surface as an error. They surface as "it just doesn't work" days later.
//
// Everything here is a pure function of MS. Raw sub-keys never leave the device; this module
// is imported into the page/content script, never called over a network boundary.
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { x25519 } from '@noble/curves/ed25519.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------------------------------------------------------------------------
// HKDF info labels — the domain separation that keeps sub-keys independent.
// These strings are consensus-critical: changing one invalidates every identity or
// conversation derived under it. They are named constants so a typo is a missing export
// rather than a silently different key.
// ---------------------------------------------------------------------------
export const LABEL = Object.freeze({
  ms: 'lortnoc/ms/v1',
  msg: 'lortnoc/msg/x25519/v1',
  own: 'lortnoc/evm/secp256k1/v1',
  sui: 'lortnoc/sui/ed25519/v1',
  conv: 'lortnoc/conv/x25519/v1',
  semaphore: 'lortnoc/semaphore/v1',
  seal: 'lortnoc/seal/v1',
})

/** secp256k1 group order — a private key must land in [1, n-1]. */
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// ---------------------------------------------------------------------------
// Master secret
// ---------------------------------------------------------------------------

/**
 * MS = HKDF(wallet signature | passphrase). The only thing a user backs up.
 *
 * Standard ECDSA signing is deterministic (RFC 6979), so the same wallet signing the same
 * fixed message reproduces the same MS on any device — nothing to memorise, nothing weak to
 * brute-force. The signature never leaves the device.
 *
 * @param {Uint8Array} seed wallet signature bytes, or Argon2id output for the passphrase fallback
 * @returns {Uint8Array} 32 bytes
 */
export function deriveMasterSecret(seed) {
  return hkdf(sha256, seed, enc.encode(LABEL.ms), enc.encode('master'), 32)
}

// ---------------------------------------------------------------------------
// Sub-keys (§5.1 table)
// ---------------------------------------------------------------------------

/** K_msg — X25519 messaging keypair (→ ENS eth.lortnoc.pubkey; native DM; conv-key ECDH). */
export function deriveMessagingKey(ms) {
  const priv = hkdf(sha256, ms, enc.encode(LABEL.msg), enc.encode('msg'), 32)
  return { priv, pub: x25519.getPublicKey(priv) }
}

/**
 * K_own — the EVM key that OWNS your handle (§4: identity wallet ≠ payment wallet).
 *
 * Derived from MS, so it costs the user nothing to hold and is never the wallet that paid.
 * The only place the two addresses are connected is inside MS, which never leaves the
 * device — so the payment on 0G and the handle on Sepolia have no on-chain link.
 *
 * HKDF output is uniform, so landing outside the secp256k1 group is astronomically
 * unlikely — but "astronomically unlikely" is not "impossible", so count up until valid.
 */
export function deriveOwnerKey(ms) {
  for (let i = 0; i < 256; i++) {
    const priv = hkdf(sha256, ms, enc.encode(`${LABEL.own}${i ? `/${i}` : ''}`), enc.encode('owner'), 32)
    const n = BigInt('0x' + toHex(priv))
    if (n > 0n && n < SECP256K1_ORDER) return { privHex: `0x${toHex(priv)}`, priv }
  }
  throw new Error('could not derive a valid owner key')
}

/** K_sui — Ed25519 storage account (pays WAL for Walrus blobs). Raw 32-byte secret. */
export function deriveSuiKey(ms) {
  // NOTE the empty info: this matches what live.ts::suiSigner already deployed, and every
  // funded testnet Sui address in use was derived with it. Changing it would silently strand
  // the WAL balance at the old address.
  return hkdf(sha256, ms, enc.encode(LABEL.sui), new Uint8Array(), 32)
}

/** id_seal — Seal decryption identity (Walrus-blob decryption). */
export function deriveSealKey(ms) {
  return hkdf(sha256, ms, enc.encode(LABEL.seal), enc.encode('seal'), 32)
}

/**
 * id_sem — the Semaphore identity secret, as the hex string `new Identity(...)` expects.
 *
 * Returned as hex rather than bytes because BOTH callers (proof.ts and membership.ts) need
 * exactly that form, and the conversion is where they could have drifted. The commitment the
 * proof is generated against must equal the commitment that was inserted when the user paid,
 * or the proof is valid for a membership nobody bought.
 */
export function deriveSemaphoreSecret(ms, index = 0) {
  // `index` exists only so the CLI can mint a second, distinct test identity: one membership
  // can mint exactly one handle (fixed scope ⇒ fixed nullifier), so testing a second claim
  // needs a second membership. Index 0 MUST produce the unsuffixed label — that is the one
  // every real user and every paid commitment on chain was derived under.
  const label = index === 0 ? LABEL.semaphore : `${LABEL.semaphore}/${index}`
  return toHex(hkdf(sha256, ms, enc.encode(label), enc.encode('sem'), 32))
}

// ---------------------------------------------------------------------------
// K_conv — the conversation key (§5.3)
// ---------------------------------------------------------------------------

const ECDH_SALT = enc.encode(LABEL.conv)

/**
 * K_conv from ECDH — identical on both ends by symmetry, no secret transmitted.
 *
 * The HKDF info binds BOTH pubkeys in sorted order, so the result does not depend on who was
 * offerer and who was acker. That is what makes glare (both sides clicking Connect) converge
 * on one key instead of two.
 *
 * @returns {Uint8Array} 64 bytes → AES-256-SIV
 */
export function deriveConvKey(myPriv, theirPub, myPub) {
  const shared = x25519.getSharedSecret(myPriv, theirPub)
  const [a, b] = [myPub, theirPub].sort(cmpBytes)
  const info = new Uint8Array(a.length + b.length)
  info.set(a, 0)
  info.set(b, a.length)
  return hkdf(sha256, shared, ECDH_SALT, info, 64)
}

/** Fresh ephemeral X25519 keypair for one conversation (§5.3 Tier 1). */
export function genKeyPair() {
  const priv = crypto.getRandomValues(new Uint8Array(32)) // any 32 bytes is a valid x25519 scalar
  return { priv, pub: x25519.getPublicKey(priv) }
}

// ---------------------------------------------------------------------------
// AES-SIV envelope — the auth tag doubles as the "is this ours?" detector (§6.1)
// ---------------------------------------------------------------------------

export function encrypt(key, plaintext) {
  return aessiv(key).encrypt(enc.encode(plaintext))
}

/** Returns the decoded message, or null if the tag doesn't verify (not one of ours). */
export function tryDecrypt(key, ciphertext) {
  try {
    return dec.decode(aessiv(key).decrypt(ciphertext))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export const toHex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')
export const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16))

export function toB64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromB64(b64) {
  const s = atob(b64)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}

function cmpBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
