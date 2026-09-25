// X Mode 3 — named recipients (PRD-x-extension.md §5, §1.1).
//
// THE PROPERTY THIS EXISTS FOR: the recipient set is invisible. One post readable by four named
// people is indistinguishable from one readable by nobody, and the readers cannot see each other
// either. That property cannot exist in a 1:1 private channel — it is the reason the X surface is
// its own product rather than a lesser copy of the Telegram overlay.
//
// ---------------------------------------------------------------------------
// LAYOUT
// ---------------------------------------------------------------------------
//
//   ephPub(32)          one ephemeral X25519 public key, shared by every recipient
//   count(1)            number of wraps
//   wrap(16) × count    seed XOR mask_i — a one-time pad, NOT an AEAD
//   body(n)             AES-SIV(CEK, plaintext)
//
// The message is encrypted ONCE under a content key and only the 16-byte seed is wrapped per
// recipient. The PRD originally specified "encrypt once per recipient; concatenate the envelopes",
// which re-encrypts the whole message N times — at the measured ~11 cover characters per payload
// byte that is unaffordable past two recipients. Here the message cost is independent of recipient
// count and only the 16-byte wraps scale.
//
// K_i = ECDH(ephemeral, recipient) run through the SAME deriveConvKey the Telegram handshake uses,
// so there is one ECDH implementation in the project rather than a second one that agrees today.
// It sorts both pubkeys into the HKDF info, so sender and recipient derive it identically without
// either knowing which side they are.
//
// WHY THE WRAP IS A XOR AND NOT AN AEAD. An AES-SIV wrap costs 48 bytes per recipient (32-byte
// seed + 16-byte tag); this costs 16. That is not a micro-optimisation — measured end to end,
// 48-byte wraps put four recipients OVER the 16-post ceiling entirely, while 16-byte wraps fit.
// The property this surface sells is the one that scales with recipient count, so every byte here
// is paid N times.
//
// It is sound because the mask comes from a FRESH ephemeral ECDH and is therefore used exactly
// once — a one-time pad, not a reused keystream. There is no per-wrap tag because the body's
// AES-SIV tag already authenticates the result: a reader XORs a candidate wrap, derives a CEK,
// and the body either authenticates or it does not. A second tag would spend 16 bytes per
// recipient re-answering a question already answered once, for the whole message.
//
// The cost is N body-decrypt attempts for a reader instead of N cheap wrap checks. Bodies are
// small and N <= 16, so that is nothing.
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT HIDE — disclose, never defend (§1.1)
// ---------------------------------------------------------------------------
//
//   * HOW MANY recipients there are: `count` is in the clear and the length scales with it. PRD §5
//     suggested padding to buckets (1, 4, 16) — deliberately NOT done, because padding multiplies
//     the dominant cost to conceal a number that post-count already correlates with.
//   * That the post is a Mode 3 post at all (the frame's mode nibble is public).
//   * Sender identity, timing, frequency, size — all inherent to broadcasting.
//
// It hides WHO the recipients are, and the message. That is the whole claim.

import {
  deriveConvKey,
  deriveContentKey,
  deriveWrapMask,
  encryptBytes,
  tryDecryptBytes,
  genKeyPair,
} from './keys.mjs'

const PUBKEY_LEN = 32
/** 16 bytes of seed entropy is ample: it keys a CEK used for exactly one message. */
const SEED_LEN = 16
const TAG_LEN = 16
/** XOR wrap — same size as the seed, no tag. See the header note. */
const WRAP_LEN = SEED_LEN

/** Practical cap. `count` is a byte, but every recipient still costs 16 bytes ≈ 180 cover
 *  characters, so a large set is several posts of pure header before the message. */
export const MAX_RECIPIENTS = 16

export const OVERHEAD = {
  ephPub: PUBKEY_LEN,
  count: 1,
  perRecipient: WRAP_LEN,
  bodyTag: TAG_LEN,
}

/** Bytes of envelope overhead before the plaintext, for `n` recipients. Used to size posts. */
export function overheadFor(n) {
  return PUBKEY_LEN + 1 + n * WRAP_LEN + TAG_LEN
}

/**
 * Seal a message to a set of X25519 public keys.
 *
 * @param {Uint8Array[]} recipientPubs 32-byte X25519 public keys, one per recipient
 * @param {Uint8Array} plaintext already squeezed, if it is going to be
 * @returns {Uint8Array} the Mode 3 payload, ready to be framed and split
 */
export function sealTo(recipientPubs, plaintext) {
  if (!recipientPubs.length) throw new Error('envelope: no recipients')
  if (recipientPubs.length > MAX_RECIPIENTS) {
    throw new Error(`envelope: ${recipientPubs.length} recipients, max ${MAX_RECIPIENTS}`)
  }
  for (const p of recipientPubs) {
    if (p.length !== PUBKEY_LEN) throw new Error(`envelope: bad pubkey length ${p.length}`)
  }

  const eph = genKeyPair()
  const seed = crypto.getRandomValues(new Uint8Array(SEED_LEN))
  const body = encryptBytes(deriveContentKey(seed), plaintext)

  const out = new Uint8Array(overheadFor(recipientPubs.length) - TAG_LEN + body.length)
  out.set(eph.pub, 0)
  out[PUBKEY_LEN] = recipientPubs.length
  let at = PUBKEY_LEN + 1
  for (const pub of recipientPubs) {
    const mask = deriveWrapMask(deriveConvKey(eph.priv, pub, eph.pub))
    for (let i = 0; i < SEED_LEN; i++) out[at + i] = seed[i] ^ mask[i]
    at += WRAP_LEN
  }
  out.set(body, at)
  return out
}

/**
 * Try to open a Mode 3 payload with your own messaging key.
 *
 * Returns the plaintext bytes if you are one of the named recipients, or null if you are not —
 * and those two cases are INDISTINGUISHABLE to everyone else, which is the point. A
 * non-recipient's key simply produces garbage seeds and fails the body tag every time.
 *
 * @param {Uint8Array} myPriv your X25519 private key (K_msg)
 * @param {Uint8Array} myPub the matching public key
 * @param {Uint8Array} payload the Mode 3 payload
 * @returns {Uint8Array|null} plaintext bytes, or null
 */
export function openSealed(myPriv, myPub, payload) {
  if (payload.length < PUBKEY_LEN + 1) return null
  const ephPub = payload.subarray(0, PUBKEY_LEN)
  const count = payload[PUBKEY_LEN]
  if (count < 1 || count > MAX_RECIPIENTS) return null

  const bodyAt = PUBKEY_LEN + 1 + count * WRAP_LEN
  if (payload.length < bodyAt + TAG_LEN) return null

  // ONE ECDH for the whole envelope: the ephemeral key is shared across recipients, so a reader
  // derives a single mask and tries it against each wrap.
  const mask = deriveWrapMask(deriveConvKey(myPriv, ephPub, myPub))
  const seed = new Uint8Array(SEED_LEN)
  for (let i = 0; i < count; i++) {
    const at = PUBKEY_LEN + 1 + i * WRAP_LEN
    for (let j = 0; j < SEED_LEN; j++) seed[j] = payload[at + j] ^ mask[j]
    // The BODY tag is the authenticator — there is no per-wrap tag to check first. A wrap that
    // is not ours yields a garbage seed, a garbage CEK, and a failed body tag.
    const plain = tryDecryptBytes(deriveContentKey(seed), payload.subarray(bodyAt))
    if (plain) return plain
  }
  return null
}
