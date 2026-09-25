// Sealed boxes between a client and the gate (docs/PRD-universal.md §5, §13.4).
//
// A key share only ever travels sealed to one X25519 key:
//   deposit — the author seals the share to the GATE's public key (published at /health)
//   release — the gate seals it to the READER's ephemeral key, generated fresh for that one request
//
// TLS protects the wire already. This adds what TLS does not: the share is bound to one recipient,
// so a gate response copied out of a log, a proxy or a browser devtools panel is useless to anyone
// but the reader who asked — and a World ID proof can bind its signal to that same reader key.
//
// Construction: fresh ephemeral X25519 → deriveConvKey (the project's ONE ECDH, shared/keys.mjs) →
// AES-SIV with a context label as associated data, so a deposit box can never be replayed as a
// release box or vice versa.
import { aessiv } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { deriveConvKey, genKeyPair, toHex, fromHex } from './keys.mjs'

const enc = new TextEncoder()
export const CTX = Object.freeze({ deposit: 'lortnoc/gate/deposit/v1', release: 'lortnoc/gate/release/v1' })

/** @returns {{eph: string, ct: string}} hex, JSON-safe */
export function sealTo(recipientPub, bytes, ctx) {
  const eph = genKeyPair()
  const pub = typeof recipientPub === 'string' ? fromHex(recipientPub) : recipientPub
  const key = deriveConvKey(eph.priv, pub, eph.pub)
  return { eph: toHex(eph.pub), ct: toHex(aessiv(key, enc.encode(ctx)).encrypt(bytes)) }
}

/** @returns {Uint8Array|null} null if the box was not sealed to this key, for this context */
export function openBox(myPriv, myPub, box, ctx) {
  try {
    const key = deriveConvKey(myPriv, fromHex(box.eph), myPub)
    return aessiv(key, enc.encode(ctx)).decrypt(fromHex(box.ct))
  } catch {
    return null
  }
}

/** The X25519 public key for a private key (the gate's long-lived key, a reader's ephemeral one). */
export const publicKeyOf = (priv) => x25519.getPublicKey(priv)
