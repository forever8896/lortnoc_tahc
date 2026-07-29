// The conversation-key derivation and AES-SIV envelope (CLAUDE.md §5.1, §5.3).
// Imports extension/src/content/crypto.ts directly — no re-implementation.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { eq, hex } from '../lib/env.mjs'

import {
  genKeyPair,
  deriveConvKey,
  encrypt,
  tryDecrypt,
  toB64,
  fromB64,
} from '../../extension/src/content/crypto.ts'

describe('K_conv derivation (§5.3 — the key is derived, never transmitted)', () => {
  test('both ends derive the identical key from opposite halves of the ECDH', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const kA = deriveConvKey(A.priv, B.pub, A.pub)
    const kB = deriveConvKey(B.priv, A.pub, B.pub)
    assert.ok(eq(kA, kB), `A derived ${hex(kA).slice(0, 12)}, B derived ${hex(kB).slice(0, 12)}`)
  })

  test('the derived key is 64 bytes — AES-256-SIV, not AES-128', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    assert.equal(deriveConvKey(A.priv, B.pub, A.pub).length, 64)
  })

  test('derivation is deterministic — a re-derive on another device reproduces it', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    assert.ok(eq(deriveConvKey(A.priv, B.pub, A.pub), deriveConvKey(A.priv, B.pub, A.pub)))
  })

  // The HKDF info binds BOTH pubkeys in sorted order precisely so that "who offered" and
  // "who acked" cannot change the result. Glare (both sides click Connect) depends on this.
  test('key does not depend on who was offerer vs acker (glare converges)', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const asOfferer = deriveConvKey(A.priv, B.pub, A.pub)
    const asAcker = deriveConvKey(A.priv, B.pub, A.pub)
    assert.ok(eq(asOfferer, asAcker))
    assert.ok(eq(asOfferer, deriveConvKey(B.priv, A.pub, B.pub)))
  })

  test('a third party with their own keypair derives a DIFFERENT key', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const E = genKeyPair()
    assert.ok(!eq(deriveConvKey(A.priv, B.pub, A.pub), deriveConvKey(E.priv, B.pub, E.pub)))
  })

  test('a peer that restarts (new keypair) yields a new key — stale keys must not carry over', () => {
    const A = genKeyPair()
    const B1 = genKeyPair()
    const B2 = genKeyPair()
    assert.ok(!eq(deriveConvKey(A.priv, B1.pub, A.pub), deriveConvKey(A.priv, B2.pub, A.pub)))
  })

  test('generated keypairs are fresh (no fixed-seed regression)', () => {
    const seen = new Set()
    for (let i = 0; i < 32; i++) seen.add(hex(genKeyPair().pub))
    assert.equal(seen.size, 32)
  })
})

describe('AES-SIV envelope — the auth tag IS the stego detector (§6.1)', () => {
  test('round-trips arbitrary UTF-8, including emoji and newlines in the PLAINTEXT', () => {
    // The plaintext is unconstrained; it is the COVER text that must stay plain (§4).
    const A = genKeyPair()
    const B = genKeyPair()
    const k = deriveConvKey(A.priv, B.pub, A.pub)
    for (const msg of ['meet at 8 by the north gate', '', 'ünïcødé ✅ 日本語', 'line\nbreak\ttab', 'x'.repeat(4096)]) {
      assert.equal(tryDecrypt(k, encrypt(k, msg)), msg, `failed for ${JSON.stringify(msg.slice(0, 24))}`)
    }
  })

  test('wrong key fails the tag and returns null — never throws, never garbles', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const E = genKeyPair()
    const good = deriveConvKey(A.priv, B.pub, A.pub)
    const bad = deriveConvKey(E.priv, B.pub, E.pub)
    assert.equal(tryDecrypt(bad, encrypt(good, 'secret')), null)
  })

  test('a flipped ciphertext bit fails the tag (integrity, not just confidentiality)', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const k = deriveConvKey(A.priv, B.pub, A.pub)
    const ct = encrypt(k, 'meet at 8 by the north gate')
    for (const i of [0, Math.floor(ct.length / 2), ct.length - 1]) {
      const tampered = Uint8Array.from(ct)
      tampered[i] ^= 0x01
      assert.equal(tryDecrypt(k, tampered), null, `bit flip at byte ${i} was NOT detected`)
    }
  })

  test('random bytes (ordinary chatter that happens to decode) fail the tag', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const k = deriveConvKey(A.priv, B.pub, A.pub)
    for (let i = 0; i < 64; i++) {
      assert.equal(tryDecrypt(k, crypto.getRandomValues(new Uint8Array(24))), null)
    }
  })

  test('truncated ciphertext fails closed rather than throwing out of tryDecrypt', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const k = deriveConvKey(A.priv, B.pub, A.pub)
    const ct = encrypt(k, 'hello there friend')
    for (const n of [0, 1, 8, 15, ct.length - 1]) {
      assert.equal(tryDecrypt(k, ct.slice(0, n)), null)
    }
  })

  // AES-SIV is deterministic (RFC 5297, no nonce supplied). Cover-text variability comes from
  // the coder's random opening nonce, NOT from the cipher — worth pinning so nobody "fixes"
  // the cipher's determinism and breaks the inbound dedupe assumptions.
  test('AES-SIV is deterministic — identical plaintext yields identical ciphertext', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const k = deriveConvKey(A.priv, B.pub, A.pub)
    assert.ok(eq(encrypt(k, 'same'), encrypt(k, 'same')))
  })

  test('the smallest ciphertext is 16 bytes — the floor MIN_COVER_WORDS is calibrated against', () => {
    const A = genKeyPair()
    const B = genKeyPair()
    const k = deriveConvKey(A.priv, B.pub, A.pub)
    assert.equal(encrypt(k, '').length, 16)
  })
})

describe('base64 transport helpers', () => {
  test('round-trips every byte value, including the 0x80-0xff range', () => {
    const all = new Uint8Array(256).map((_, i) => i)
    assert.ok(eq(fromB64(toB64(all)), all))
  })

  test('agrees with Node Buffer base64 (the service worker and codec must interop)', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(97))
    assert.equal(toB64(bytes), Buffer.from(bytes).toString('base64'))
  })

  test('round-trips the empty payload', () => {
    assert.equal(toB64(new Uint8Array(0)), '')
    assert.equal(fromB64('').length, 0)
  })
})
