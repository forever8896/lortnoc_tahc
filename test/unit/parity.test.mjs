// CROSS-IMPLEMENTATION PARITY — the drift detector.
//
// `deriveConvKey`, `encrypt`, `tryDecrypt` and `cmpBytes` are copy-pasted between
// extension/src/content/crypto.ts and app/src/lib/crypto.ts. CLAUDE.md §3 promises "three
// surfaces, ONE key set": a user who handshakes in the Telegram overlay must be able to read
// the same thread in the web app. Nothing enforced that — the two files simply happened to
// agree, and the failure mode if they stopped is silent (each surface reads only its own
// messages, exactly the class of bug the handshake comments describe fighting repeatedly).
//
// This file imports BOTH implementations and asserts they are interchangeable. If someone
// edits one salt, one HKDF length, or one sort order, this goes red immediately.
//
// The real fix is to collapse them into shared/ — the same argument shared/ticket.mjs makes
// in its own header ("ONE implementation ... two copies would eventually disagree"). Until
// that refactor lands, this test is the seam that makes the duplication survivable.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { eq, hex, source as readSrc } from '../lib/env.mjs'

import * as ext from '../../extension/src/content/crypto.ts'
import * as app from '../../app/src/lib/crypto.ts'

describe('extension crypto ≡ app crypto (§3 "one key set")', () => {
  test('both derive the SAME conversation key from the same ECDH inputs', () => {
    const A = ext.genKeyPair()
    const B = app.deriveMessagingKey(new Uint8Array(32).fill(7))
    const fromExt = ext.deriveConvKey(A.priv, B.pub, A.pub)
    const fromApp = app.deriveConvKey(A.priv, B.pub, A.pub)
    assert.ok(eq(fromExt, fromApp), `extension ${hex(fromExt).slice(0, 16)} vs app ${hex(fromApp).slice(0, 16)}`)
  })

  test('a message encrypted in the extension opens in the app', () => {
    const A = ext.genKeyPair()
    const B = app.deriveMessagingKey(new Uint8Array(32).fill(3))
    const k = ext.deriveConvKey(A.priv, B.pub, A.pub)
    assert.equal(app.tryDecrypt(k, ext.encrypt(k, 'sent from telegram')), 'sent from telegram')
  })

  test('a message encrypted in the app opens in the extension', () => {
    const A = ext.genKeyPair()
    const B = app.deriveMessagingKey(new Uint8Array(32).fill(9))
    const k = app.deriveConvKey(B.priv, A.pub, B.pub)
    assert.equal(ext.tryDecrypt(k, app.encrypt(k, 'sent from the web app')), 'sent from the web app')
  })

  // Cross-surface: the app's wallet-derived K_msg (§5.1) and the extension's ephemeral
  // handshake key must produce a working shared key. This is the Mirror-mode path — an app
  // user reading a thread the overlay established.
  test('app K_msg and an extension ephemeral key agree on K_conv', () => {
    const ms = app.deriveMasterSecret(new Uint8Array(32).fill(0x5a))
    const appKey = app.deriveMessagingKey(ms)
    const extKey = ext.genKeyPair()
    const kApp = app.deriveConvKey(appKey.priv, extKey.pub, appKey.pub)
    const kExt = ext.deriveConvKey(extKey.priv, appKey.pub, extKey.pub)
    assert.ok(eq(kApp, kExt))
  })

  test('both agree that a wrong key fails (same detector semantics)', () => {
    const A = ext.genKeyPair()
    const B = ext.genKeyPair()
    const E = ext.genKeyPair()
    const good = ext.deriveConvKey(A.priv, B.pub, A.pub)
    const bad = ext.deriveConvKey(E.priv, B.pub, E.pub)
    const ct = ext.encrypt(good, 'x')
    assert.equal(ext.tryDecrypt(bad, ct), null)
    assert.equal(app.tryDecrypt(bad, ct), null)
  })

  test('neither surface re-implements the derivation — both re-export shared/keys.mjs', () => {
    // The duplication this file was written to survive has since been collapsed into
    // shared/keys.mjs. This test now guards against it coming BACK: a well-meaning "just
    // inline it here to avoid the import" is exactly how the seven copies accumulated.
    for (const path of ['extension/src/content/crypto.ts', 'app/src/lib/crypto.ts']) {
      const src = readSrc(path)
      assert.match(src, /from '.*shared\/keys\.mjs'/, `${path} no longer sources its crypto from shared/`)
      assert.doesNotMatch(src, /hkdf\(sha256/, `${path} re-implements a key derivation`)
      assert.doesNotMatch(src, /getSharedSecret/, `${path} re-implements the ECDH`)
    }
  })

  test('the consensus-critical HKDF labels are pinned', () => {
    // Changing any of these invalidates every identity or conversation derived under it:
    // existing sessions stop opening, and on-chain commitments stop matching their proofs.
    assert.deepEqual(
      { ...app.LABEL },
      {
        ms: 'lortnoc/ms/v1',
        msg: 'lortnoc/msg/x25519/v1',
        own: 'lortnoc/evm/secp256k1/v1',
        sui: 'lortnoc/sui/ed25519/v1',
        conv: 'lortnoc/conv/x25519/v1',
        semaphore: 'lortnoc/semaphore/v1',
        seal: 'lortnoc/seal/v1',
      },
      'an HKDF label changed — this breaks every existing key derived under it',
    )
  })
})

describe('master-secret derivation (§5.1) — app only, but pinned', () => {
  test('MS is deterministic: same wallet signature reproduces the same identity anywhere', () => {
    const sig = new Uint8Array(65).fill(0x11)
    assert.ok(eq(app.deriveMasterSecret(sig), app.deriveMasterSecret(sig)))
  })

  test('every sub-key is domain-separated — no two derivations collide', () => {
    const ms = app.deriveMasterSecret(new Uint8Array(65).fill(0x22))
    const keys = [
      hex(app.deriveMessagingKey(ms).priv),
      hex(app.deriveOwnerKey(ms).priv),
      hex(app.deriveSealKey(ms)),
      hex(ms),
    ]
    assert.equal(new Set(keys).size, keys.length, 'two derived keys are equal — HKDF info labels collide')
  })

  test('the owner key is a valid secp256k1 scalar (§5.1 rejection sampling)', () => {
    const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    for (let i = 0; i < 16; i++) {
      const ms = app.deriveMasterSecret(new Uint8Array(32).fill(i))
      const n = BigInt(app.deriveOwnerKey(ms).privHex)
      assert.ok(n > 0n && n < ORDER, `owner key out of range for seed ${i}`)
    }
  })

  test('K_own is NOT the messaging key — identity wallet ≠ payment wallet is structural (§4)', () => {
    const ms = app.deriveMasterSecret(new Uint8Array(32).fill(0x44))
    assert.notEqual(hex(app.deriveOwnerKey(ms).priv), hex(app.deriveMessagingKey(ms).priv))
  })

  test('id_sem is one derivation — the commitment paid for equals the one proved against', () => {
    // proof.ts::identityFrom and membership.ts::commitmentFrom both used to inline this. Their
    // own comment warned they must match "or the proof would be generated against a commitment
    // that was never paid for". They now share it; this pins the value and the index rule.
    const ms = app.deriveMasterSecret(new Uint8Array(32).fill(0x77))
    const secret = app.deriveSemaphoreSecret(ms)
    assert.equal(secret, app.deriveSemaphoreSecret(ms, 0), 'index 0 must equal the unsuffixed label')
    assert.match(secret, /^[0-9a-f]{64}$/, 'Semaphore identity secret is not 32 bytes of hex')
    // A CLI test identity must be distinct, or two "different" memberships share a nullifier.
    assert.notEqual(secret, app.deriveSemaphoreSecret(ms, 1))
  })

  test('K_sui keeps the EMPTY HKDF info that funded testnet addresses were derived under', () => {
    // live.ts::suiSigner passed `new Uint8Array()` as the info, unlike every other derivation
    // in the table, which pass a short string. Tidying that inconsistency away would change the
    // key, and therefore the Sui address — silently stranding the WAL balance the demo spends.
    // Asserted against the source because the whole point is that this odd-looking line stays.
    assert.match(
      readSrc('shared/keys.mjs'),
      /return hkdf\(sha256, ms, enc\.encode\(LABEL\.sui\), new Uint8Array\(\), 32\)/,
      'the K_sui HKDF info changed — every funded Sui address moves and the WAL is stranded',
    )
    const ms = app.deriveMasterSecret(new Uint8Array(32).fill(0x88))
    assert.equal(app.deriveSuiKey(ms).length, 32)
    assert.equal(hex(app.deriveSuiKey(ms)), hex(app.deriveSuiKey(ms)))
  })

  test('a different signature yields a completely different identity', () => {
    const a = app.deriveMasterSecret(new Uint8Array(65).fill(0x01))
    const b = app.deriveMasterSecret(new Uint8Array(65).fill(0x02))
    assert.ok(!eq(a, b))
    assert.ok(!eq(app.deriveMessagingKey(a).pub, app.deriveMessagingKey(b).pub))
  })
})
