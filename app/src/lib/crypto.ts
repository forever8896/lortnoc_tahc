// Client-side crypto — shared with the extension (§5.1/§5.3). Keys never leave the device.
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { x25519 } from '@noble/curves/ed25519.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

export type KeyPair = { priv: Uint8Array; pub: Uint8Array }

/** MS = HKDF(wallet signature | passphrase). The only thing a user backs up. */
export function deriveMasterSecret(seed: Uint8Array): Uint8Array {
  return hkdf(sha256, seed, enc.encode('lortnoc/ms/v1'), enc.encode('master'), 32)
}

/** K_msg — X25519 messaging keypair (→ ENS eth.lortnoc.pubkey; native DM; conv-key ECDH). */
export function deriveMessagingKey(ms: Uint8Array): KeyPair {
  const priv = hkdf(sha256, ms, enc.encode('lortnoc/msg/x25519/v1'), enc.encode('msg'), 32)
  return { priv, pub: x25519.getPublicKey(priv) }
}

/**
 * The EVM key that OWNS your handle (§4: identity wallet ≠ payment wallet).
 *
 * Derived from MS, so it costs the user nothing to hold — the same wallet signature reproduces
 * it on any device — and it is never the wallet that paid. The only place those two addresses
 * are connected is inside MS, which never leaves the device, so the payment on 0G and the handle
 * on Sepolia have no on-chain link.
 *
 * It never has to send a transaction to receive the handle (the relayer does that), but it can
 * sign whenever the user wants to manage their own records.
 */
export function deriveOwnerKey(ms: Uint8Array): { privHex: `0x${string}`; priv: Uint8Array } {
  // secp256k1 keys must land in [1, n-1]. HKDF output is uniform, so a miss is astronomically
  // unlikely — but "astronomically unlikely" is not "impossible", so count up until it is valid.
  for (let i = 0; i < 256; i++) {
    const priv = hkdf(sha256, ms, enc.encode(`lortnoc/evm/secp256k1/v1${i ? `/${i}` : ''}`), enc.encode('owner'), 32)
    const n = BigInt('0x' + Array.from(priv, (b) => b.toString(16).padStart(2, '0')).join(''))
    const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    if (n > 0n && n < ORDER) {
      return { privHex: `0x${Array.from(priv, (b) => b.toString(16).padStart(2, '0')).join('')}`, priv }
    }
  }
  throw new Error('could not derive a valid owner key')
}

/** id_seal — Seal decryption identity (Walrus-blob decryption). */
export function deriveSealKey(ms: Uint8Array): Uint8Array {
  return hkdf(sha256, ms, enc.encode('lortnoc/seal/v1'), enc.encode('seal'), 32)
}

const ECDH_SALT = enc.encode('lortnoc/conv/x25519/v1')

/** K_conv from ECDH — identical on both ends by symmetry (§5.3). */
export function deriveConvKey(myPriv: Uint8Array, theirPub: Uint8Array, myPub: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myPriv, theirPub)
  const [a, b] = [myPub, theirPub].sort(cmpBytes)
  const info = new Uint8Array(a.length + b.length)
  info.set(a, 0)
  info.set(b, a.length)
  return hkdf(sha256, shared, ECDH_SALT, info, 64) // 64 → AES-256-SIV
}

export function encrypt(key: Uint8Array, plaintext: string): Uint8Array {
  return aessiv(key).encrypt(enc.encode(plaintext))
}
export function tryDecrypt(key: Uint8Array, ct: Uint8Array): string | null {
  try {
    return dec.decode(aessiv(key).decrypt(ct))
  } catch {
    return null
  }
}

export const toHex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/.{1,2}/g)!.map((x) => parseInt(x, 16)))

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
