// Types for keys.mjs — the module stays plain JS so plain-node callers (scripts/, relayer/)
// can import it without a build step, while the extension and app still get checked.

export type KeyPair = { priv: Uint8Array; pub: Uint8Array }

/** HKDF `info` labels from the CLAUDE.md §5.1 table. Consensus-critical strings. */
export const LABEL: Readonly<{
  ms: string
  msg: string
  own: string
  sui: string
  conv: string
  semaphore: string
  seal: string
}>

/** MS = HKDF(wallet signature | passphrase). The only thing a user backs up. */
export function deriveMasterSecret(seed: Uint8Array): Uint8Array

/** K_msg — X25519 messaging keypair (→ ENS eth.lortnoc.pubkey; native DM; conv-key ECDH). */
export function deriveMessagingKey(ms: Uint8Array): KeyPair

/** K_own — the EVM key that OWNS the handle. Never the wallet that paid (§4). */
export function deriveOwnerKey(ms: Uint8Array): { privHex: `0x${string}`; priv: Uint8Array }

/** K_sui — Ed25519 storage-account secret (pays WAL for Walrus blobs). */
export function deriveSuiKey(ms: Uint8Array): Uint8Array

/** id_seal — Seal decryption identity. */
export function deriveSealKey(ms: Uint8Array): Uint8Array

/** id_sem — Semaphore identity secret, hex-encoded as `new Identity(...)` expects.
 *  `index` is a CLI-only escape hatch for minting a second test identity; 0 is the real one. */
export function deriveSemaphoreSecret(ms: Uint8Array, index?: number): string

/** K_conv from ECDH — identical on both ends by symmetry (§5.3). 64 bytes → AES-256-SIV. */
export function deriveConvKey(myPriv: Uint8Array, theirPub: Uint8Array, myPub: Uint8Array): Uint8Array

/** Fresh ephemeral X25519 keypair for one conversation. */
export function genKeyPair(): KeyPair

export function encrypt(key: Uint8Array, plaintext: string): Uint8Array

/** Returns the decoded message, or null if the tag doesn't verify (not one of ours). */
export function tryDecrypt(key: Uint8Array, ciphertext: Uint8Array): string | null

export function toHex(u: Uint8Array): string
export function fromHex(h: string): Uint8Array
export function toB64(bytes: Uint8Array): string
export function fromB64(b64: string): Uint8Array
