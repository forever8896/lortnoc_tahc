// Types for envelope.mjs — the module stays plain JS so plain-node callers (tests, scripts) can
// import it without a build step, while the extension still gets checked.

/** Max recipients in one envelope. Each costs 16 bytes ≈ 180 cover characters. */
export const MAX_RECIPIENTS: number

/** The fixed pieces of the Mode 3 layout, in bytes. */
export const OVERHEAD: Readonly<{
  ephPub: number
  count: number
  perRecipient: number
  bodyTag: number
}>

/** Envelope overhead before the plaintext, for `n` recipients. Used to size posts. */
export function overheadFor(n: number): number

/**
 * Seal a message to a set of X25519 public keys.
 *
 * Throws on no recipients, more than MAX_RECIPIENTS, or a malformed pubkey — all cases where
 * producing a post would mean producing one nobody can open.
 */
export function sealTo(recipientPubs: Uint8Array[], plaintext: Uint8Array): Uint8Array

/**
 * Open a Mode 3 payload with your own messaging key, or null if it is not addressed to you.
 *
 * "Not addressed to you" and "addressed to four other people" are indistinguishable from the
 * outside — that is the property the mode exists for. Never throws; malformed input returns null.
 */
export function openSealed(
  myPriv: Uint8Array,
  myPub: Uint8Array,
  payload: Uint8Array,
): Uint8Array | null
