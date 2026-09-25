// X Mode 3 — named recipients (shared/envelope.mjs).
//
// The property under test is unusual and worth naming: it is not just "recipients can read it",
// it is that a NON-recipient cannot distinguish a post addressed to four people from one
// addressed to nobody. So the interesting assertions are the negative ones — a stranger's key
// must fail identically regardless of who else was named.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from '../lib/env.mjs'

import { sealTo, openSealed, overheadFor, MAX_RECIPIENTS } from '../../shared/envelope.mjs'
import { genKeyPair, deriveMessagingKey, deriveMasterSecret } from '../../shared/keys.mjs'
import { squeezeIfSmaller, unsqueezeMaybe } from '../../shared/squeeze.mjs'

const enc = new TextEncoder()
const bytes = (s) => enc.encode(s)
/** A deterministic identity, so failures are reproducible. */
const identity = (label) => deriveMessagingKey(deriveMasterSecret(bytes(`test-identity-${label}`)))

describe('sealing and opening', () => {
  test('a single named recipient can open it', () => {
    const alice = identity('alice')
    const payload = sealTo([alice.pub], bytes('meet at 8'))
    assert.ok(eq(openSealed(alice.priv, alice.pub, payload), bytes('meet at 8')))
  })

  test('every recipient in a set can open it, independently', () => {
    const people = ['a', 'b', 'c', 'd'].map(identity)
    const payload = sealTo(people.map((p) => p.pub), bytes('the usual place'))
    for (const [i, p] of people.entries()) {
      assert.ok(eq(openSealed(p.priv, p.pub, payload), bytes('the usual place')), `recipient ${i} failed`)
    }
  })

  test('a stranger gets null — the auth tag is the whole gate', () => {
    const people = ['a', 'b', 'c'].map(identity)
    const stranger = identity('stranger')
    const payload = sealTo(people.map((p) => p.pub), bytes('secret'))
    assert.equal(openSealed(stranger.priv, stranger.pub, payload), null)
  })

  test('a REVOKED recipient cannot open the next message', () => {
    const [a, b] = ['a', 'b'].map(identity)
    const first = sealTo([a.pub, b.pub], bytes('still friends'))
    const second = sealTo([a.pub], bytes('not any more'))
    assert.ok(eq(openSealed(b.priv, b.pub, first), bytes('still friends')))
    assert.equal(openSealed(b.priv, b.pub, second), null)
  })

  test('two seals of the SAME message differ — the ephemeral key is fresh each time', () => {
    // Mode 1 is deterministic (AES-SIV with a fixed key), which leaks repetition across the
    // permanent public corpus. Mode 3 does not have that problem, and this pins it.
    const alice = identity('alice')
    const one = sealTo([alice.pub], bytes('ok'))
    const two = sealTo([alice.pub], bytes('ok'))
    assert.ok(!eq(one, two), 'identical plaintext produced identical ciphertext')
    assert.ok(eq(openSealed(alice.priv, alice.pub, one), bytes('ok')))
    assert.ok(eq(openSealed(alice.priv, alice.pub, two), bytes('ok')))
  })
})

describe('the recipient set is invisible', () => {
  test('a stranger cannot tell one recipient from many', () => {
    // The claim in §1.1: "readable by four named people" is indistinguishable from "readable by
    // nobody" to anyone who is not one of them. What a stranger CAN see is the count — that is
    // disclosed, not defended — so the assertion is that the failure is identical either way.
    const stranger = identity('stranger')
    for (const n of [1, 2, 4, 8]) {
      const people = Array.from({ length: n }, (_, i) => identity(`p${i}`))
      const payload = sealTo(people.map((p) => p.pub), bytes('same message'))
      assert.equal(openSealed(stranger.priv, stranger.pub, payload), null, `n=${n} leaked`)
    }
  })

  test('a recipient cannot learn WHO the other recipients are', () => {
    // Each wrap is opaque without the matching key: a reader learns only that N wraps exist.
    const [a, b] = ['a', 'b'].map(identity)
    const c = identity('c')
    const payload = sealTo([a.pub, b.pub, c.pub], bytes('hello'))
    // A can read the message...
    assert.ok(eq(openSealed(a.priv, a.pub, payload), bytes('hello')))
    // ...but B's and C's public keys appear nowhere in the payload.
    const hay = Buffer.from(payload).toString('hex')
    for (const [name, p] of [['b', b], ['c', c]]) {
      assert.ok(!hay.includes(Buffer.from(p.pub).toString('hex')), `${name}'s pubkey is in the payload`)
    }
  })
})

describe('cost — the property we sell is the property that is expensive', () => {
  test('overhead scales with recipients, NOT with message length', () => {
    // This is the whole reason for the content-key design. If overhead depended on the message,
    // cover text would scale with recipients × message and Mode 3 would be unusable.
    const alice = identity('alice')
    const short = sealTo([alice.pub], bytes('hi'))
    const long = sealTo([alice.pub], bytes('x'.repeat(200)))
    assert.equal(long.length - short.length, 198, 'message growth must be 1:1, not multiplied')
  })

  test('overheadFor matches what sealTo actually produces', () => {
    for (const n of [1, 2, 4, 16]) {
      const people = Array.from({ length: n }, (_, i) => identity(`q${i}`))
      const payload = sealTo(people.map((p) => p.pub), new Uint8Array(0))
      assert.equal(payload.length, overheadFor(n), `overheadFor(${n}) disagrees with sealTo`)
    }
  })

  test('the documented per-recipient cost is 16 bytes', () => {
    // Quoted in the PRD and used to size posts; if it changes, the sizing maths is wrong.
    // It was 48 with an AEAD wrap, which measured OVER the 16-post ceiling at four recipients.
    assert.equal(overheadFor(2) - overheadFor(1), 16)
  })

  test('a 4-recipient envelope stays under 120 bytes of header', () => {
    // The ceiling that matters: at ~11 cover characters per byte, 120 bytes is ~5 posts of
    // header. Above roughly this the mode stops being usable at all, which is what the
    // 48-byte wrap did.
    assert.ok(overheadFor(4) <= 120, `4-recipient overhead is ${overheadFor(4)}B`)
  })
})

describe('rejection paths', () => {
  test('refuses to seal to nobody, or to too many', () => {
    assert.throws(() => sealTo([], bytes('x')), /no recipients/)
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => identity(`r${i}`).pub)
    assert.throws(() => sealTo(many, bytes('x')), /max/)
  })

  test('refuses a malformed pubkey rather than producing an unopenable post', () => {
    assert.throws(() => sealTo([new Uint8Array(31)], bytes('x')), /pubkey length/)
  })

  test('truncated or garbage payloads return null, never throw', () => {
    const alice = identity('alice')
    const payload = sealTo([alice.pub], bytes('meet at 8'))
    for (const cut of [0, 1, 20, 33, 40, payload.length - 1]) {
      assert.equal(openSealed(alice.priv, alice.pub, payload.subarray(0, cut)), null, `cut=${cut} threw or opened`)
    }
    assert.equal(openSealed(alice.priv, alice.pub, crypto.getRandomValues(new Uint8Array(120))), null)
  })

  test('a tampered body fails the tag', () => {
    const alice = identity('alice')
    const payload = sealTo([alice.pub], bytes('meet at 8'))
    payload[payload.length - 1] ^= 0x01
    assert.equal(openSealed(alice.priv, alice.pub, payload), null)
  })
})

describe('end to end with squeeze', () => {
  test('a real message survives squeeze -> seal -> open -> unsqueeze', () => {
    const people = ['a', 'b'].map(identity)
    const real = 'call me when you land, same number as before'
    const { bytes: squeezed, compressed } = squeezeIfSmaller(real)
    const payload = sealTo(people.map((p) => p.pub), squeezed)
    for (const p of people) {
      const out = openSealed(p.priv, p.pub, payload)
      assert.equal(unsqueezeMaybe(out, compressed), real)
    }
  })
})
