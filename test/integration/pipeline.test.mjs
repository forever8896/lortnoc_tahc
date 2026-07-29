// End-to-end proof of the extension's data path against a LIVE codec, with no browser.
//
// Replaces the old extension/test/pipeline.test.mjs, which re-implemented crypto.ts inline
// against a passphrase-derived key — a derivation the product had already deleted. This one
// imports the real modules, so it fails when the product changes.
//
// Needs a codec:  (cd codec && python3 server.py)     [CODEC=http://host:port to point elsewhere]
// Skips cleanly when none is reachable, so the default `npm test` stays green offline.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { codecUp, codecEncode, codecDecode, CODEC, eq, source } from '../lib/env.mjs'

import { genKeyPair, deriveConvKey, encrypt, tryDecrypt, toB64, fromB64 } from '../../extension/src/content/crypto.ts'
import { buildFrame, parseFrame, FRAME } from '../../extension/src/content/handshake.ts'

let health = null
before(async () => {
  health = await codecUp()
  if (!health) {
    console.log(`\n  ⚠ no codec at ${CODEC} — integration tests skipped.` +
                `\n    start one with:  cd codec && python3 server.py\n`)
  } else {
    console.log(`\n  ✓ codec: ${health.model} (${health.digest}) · select=${health.select}\n`)
  }
})

const needsCodec = () => (health ? false : { skip: `no codec at ${CODEC}` })

// A keyed pair of correspondents, as the two ends of a real conversation.
const alice = genKeyPair()
const bob = genKeyPair()
const kAlice = deriveConvKey(alice.priv, bob.pub, alice.pub)
const kBob = deriveConvKey(bob.priv, alice.pub, bob.pub)

describe('outbound → inbound round trip (§6.1)', () => {
  test('a real message survives encrypt → encode → decode → decrypt', async (t) => {
    if (!health) return t.skip('no codec')
    const real = 'meet at 8 by the north gate'
    const { status, body } = await codecEncode(toB64(encrypt(kAlice, real)))
    assert.equal(status, 200, JSON.stringify(body))
    const back = await codecDecode(body.coverText)
    assert.equal(back.status, 200)
    assert.equal(tryDecrypt(kBob, fromB64(back.body.ciphertext)), real, 'Bob could not read Alice')
  })

  test('a stranger holding a different key gets null, not garbage', async (t) => {
    if (!health) return t.skip('no codec')
    const eve = genKeyPair()
    const kEve = deriveConvKey(eve.priv, bob.pub, eve.pub)
    const { body } = await codecEncode(toB64(encrypt(kAlice, 'secret plan')))
    const back = await codecDecode(body.coverText)
    assert.equal(tryDecrypt(kEve, fromB64(back.body.ciphertext)), null)
  })

  test('ordinary chatter returns 422 — the cacheable "not ours" verdict', async (t) => {
    if (!health) return t.skip('no codec')
    for (const chatter of ['hey are you free tonight', 'ok see you then', 'sounds good to me']) {
      const { status } = await codecDecode(chatter)
      assert.equal(status, 422, `${chatter} was not rejected`)
    }
  })

  test('messages of many lengths all round-trip', async (t) => {
    if (!health) return t.skip('no codec')
    for (const real of ['a', 'ok', 'x'.repeat(200), 'ünïcødé ✅ in the PLAINTEXT is fine']) {
      const { body } = await codecEncode(toB64(encrypt(kAlice, real)))
      const back = await codecDecode(body.coverText)
      assert.equal(tryDecrypt(kBob, fromB64(back.body.ciphertext)), real, `failed at length ${real.length}`)
    }
  })
})

describe('reversibility (§4 codec determinism)', () => {
  test('the same input encodes DIFFERENTLY but decodes IDENTICALLY', async (t) => {
    if (!health) return t.skip('no codec')
    // Variability is intended (random opening nonce + best-of-N selection). What must hold
    // is that every distinct cover decodes back to the identical ciphertext.
    const ct = encrypt(kAlice, 'meet at 8 by the north gate')
    const a = await codecEncode(toB64(ct))
    const b = await codecEncode(toB64(ct))
    const backA = await codecDecode(a.body.coverText)
    const backB = await codecDecode(b.body.coverText)
    assert.equal(backA.body.ciphertext, backB.body.ciphertext, 'reversibility broke')
    assert.equal(backA.body.ciphertext, toB64(ct))
  })

  test('100 random payloads round-trip byte-exactly (the §6.2 first milestone)', async (t) => {
    if (!health) return t.skip('no codec')
    // CLAUDE.md §6.2: "First milestone: decode(encode(x)) == x for 100 random payloads."
    // Reduced to 25 when running against a real model, which costs seconds per call.
    const n = health.model?.startsWith('gpt2') ? 25 : 100
    for (let i = 0; i < n; i++) {
      const payload = crypto.getRandomValues(new Uint8Array(1 + (i % 48)))
      const { body } = await codecEncode(toB64(payload))
      const back = await codecDecode(body.coverText)
      assert.equal(back.status, 200, `payload ${i} failed to decode`)
      assert.ok(eq(fromB64(back.body.ciphertext), payload), `payload ${i} did not round-trip`)
    }
  })
})

describe('cover text is Telegram-safe (§4 "cover text stays plain")', () => {
  test('contains only lowercase ASCII words and single spaces', async (t) => {
    if (!health) return t.skip('no codec')
    for (let i = 0; i < 5; i++) {
      const { body } = await codecEncode(toB64(encrypt(kAlice, `message number ${i}`)))
      const cover = body.coverText
      assert.match(cover, /^[a-z]+( [a-z]+)*$/, `cover text is not plain: ${JSON.stringify(cover)}`)
    }
  })

  test('survives the normalisations Telegram actually applies', async (t) => {
    if (!health) return t.skip('no codec')
    // The Phase-0 blocker from §11: if Telegram rewrites the text, byte-exact decoding dies.
    // We cannot drive Telegram from here, so we apply its known transforms and assert the
    // cover text is a fixed point of every one of them.
    const { body } = await codecEncode(toB64(encrypt(kAlice, 'meet at 8 by the north gate')))
    const cover = body.coverText
    const transforms = {
      'trim': (s) => s.trim(),
      'collapse runs of whitespace': (s) => s.replace(/\s+/g, ' '),
      'NFC unicode normalisation': (s) => s.normalize('NFC'),
      'smart-quote substitution': (s) => s.replace(/'/g, '’').replace(/"/g, '”'),
      'markdown autoformat': (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1'),
      'HTML entity escaping': (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    }
    for (const [name, fn] of Object.entries(transforms)) {
      assert.equal(fn(cover), cover, `cover text is altered by: ${name}`)
    }
    // And it still decodes after a full round through them all.
    const mangled = Object.values(transforms).reduce((s, fn) => fn(s), cover)
    const back = await codecDecode(mangled)
    assert.equal(back.status, 200, 'the cover text did not survive Telegram-style normalisation')
  })
})

describe('handshake frames through the real codec (§5.3 Tier 1)', () => {
  test('an OFFER frame survives the codec as cover text', async (t) => {
    if (!health) return t.skip('no codec')
    const frame = buildFrame(FRAME.OFFER, alice.pub)
    const { body } = await codecEncode(toB64(frame), { fast: true })
    const back = await codecDecode(body.coverText)
    const parsed = parseFrame(fromB64(back.body.ciphertext))
    assert.ok(parsed, 'the handshake frame did not survive the codec')
    assert.equal(parsed.type, FRAME.OFFER)
    assert.ok(eq(parsed.pubkey, alice.pub))
  })

  test('a full two-way handshake, then a message, all through the codec', async (t) => {
    if (!health) return t.skip('no codec')
    // Alice offers.
    const offer = await codecEncode(toB64(buildFrame(FRAME.OFFER, alice.pub)), { fast: true })
    const offerBack = parseFrame(fromB64((await codecDecode(offer.body.coverText)).body.ciphertext))
    // Bob accepts with his own pubkey and derives the key.
    const bobKey = deriveConvKey(bob.priv, offerBack.pubkey, bob.pub)
    const ack = await codecEncode(toB64(buildFrame(FRAME.ACK, bob.pub)), { fast: true })
    const ackBack = parseFrame(fromB64((await codecDecode(ack.body.coverText)).body.ciphertext))
    // Alice derives from the ACK; both must agree.
    const aliceKey = deriveConvKey(alice.priv, ackBack.pubkey, alice.pub)
    assert.ok(eq(aliceKey, bobKey), 'the handshake did not converge on one key')
    // And a real message crosses on that key.
    const msg = await codecEncode(toB64(encrypt(aliceKey, 'it worked')))
    const msgBack = await codecDecode(msg.body.coverText)
    assert.equal(tryDecrypt(bobKey, fromB64(msgBack.body.ciphertext)), 'it worked')
  })

  test('a handshake encode is never metered and skips best-of-N', async (t) => {
    if (!health) return t.skip('no codec')
    const { body } = await codecEncode(toB64(buildFrame(FRAME.ACK, bob.pub)), { fast: true })
    assert.equal(body.select, 'single', 'a handshake frame ran best-of-N (slow, and pointless)')
  })
})

describe('cross-component coupling: MIN_COVER_WORDS', () => {
  test('the shortest real cover text clears the inbound word-count floor', async (t) => {
    if (!health) return t.skip('no codec')
    // inbound.ts rejects any bubble under MIN_COVER_WORDS words WITHOUT calling the codec,
    // as a cheap pre-filter. That constant is calibrated against "a 16-byte AES-SIV
    // ciphertext comes back as 27 words" — which depends on CODEC_K, an env var. Raise
    // CODEC_K and covers get shorter; cross the floor and the extension silently discards
    // its own messages, with no error anywhere. This is the test that catches that.
    const MIN_COVER_WORDS = readMinCoverWords()
    const smallest = encrypt(kAlice, '') // 16 bytes, the floor from crypto.test.mjs
    const { body } = await codecEncode(toB64(smallest))
    const words = body.coverText.trim().split(/\s+/).length
    assert.ok(
      words >= MIN_COVER_WORDS,
      `the shortest cover text is ${words} words but inbound.ts discards anything under ` +
      `${MIN_COVER_WORDS}. Backend=${health.model}. Lower MIN_COVER_WORDS or lower CODEC_K.`,
    )
  })
})

function readMinCoverWords() {
  const m = /const MIN_COVER_WORDS = (\d+)/.exec(source('extension/src/content/inbound.ts'))
  assert.ok(m, 'MIN_COVER_WORDS is gone from inbound.ts — this test needs updating')
  return Number(m[1])
}
