// Tier-1 in-band handshake framing (§5.3). Imports the real parseFrame/buildFrame.
//
// Framing is the layer that decides "is this bubble a key exchange, a message, or ordinary
// chatter?" — and every wrong answer is a silent failure: a mis-parsed frame either keys the
// user to a pubkey the peer discarded or swallows a real message. Hence the emphasis on the
// REJECTION paths, which are what actually break in the field.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from '../lib/env.mjs'

import { buildFrame, parseFrame, FRAME } from '../../extension/src/content/handshake.ts'
import { genKeyPair } from '../../extension/src/content/crypto.ts'

const FRAME_LEN = 41 // MAGIC(4) + type(1) + pubkey(32) + crc32(4)

describe('frame round-trip', () => {
  for (const [name, type] of [['OFFER', FRAME.OFFER], ['ACK', FRAME.ACK]]) {
    test(`${name} round-trips with the pubkey intact`, () => {
      const { pub } = genKeyPair()
      const parsed = parseFrame(buildFrame(type, pub))
      assert.ok(parsed, `${name} failed to parse`)
      assert.equal(parsed.type, type)
      assert.ok(eq(parsed.pubkey, pub))
    })
  }

  test('frames are exactly 41 bytes — the wire format is pinned', () => {
    assert.equal(buildFrame(FRAME.OFFER, genKeyPair().pub).length, FRAME_LEN)
  })

  test('OFFER and ACK are distinguishable (0x01 vs 0x02, §5.3)', () => {
    assert.equal(FRAME.OFFER, 0x01)
    assert.equal(FRAME.ACK, 0x02)
    const { pub } = genKeyPair()
    assert.notEqual(parseFrame(buildFrame(FRAME.OFFER, pub)).type, parseFrame(buildFrame(FRAME.ACK, pub)).type)
  })

  test('every distinct pubkey survives byte-for-byte (no sign/truncation bug)', () => {
    for (let i = 0; i < 50; i++) {
      const { pub } = genKeyPair()
      assert.ok(eq(parseFrame(buildFrame(FRAME.ACK, pub)).pubkey, pub))
    }
  })

  test('the parsed pubkey is a COPY, not a view into the frame buffer', () => {
    // parseFrame uses .slice(); if it ever becomes .subarray(), mutating the frame would
    // retroactively corrupt a stored session key.
    const { pub } = genKeyPair()
    const frame = buildFrame(FRAME.OFFER, pub)
    const parsed = parseFrame(frame)
    frame.fill(0)
    assert.ok(eq(parsed.pubkey, pub), 'parsed pubkey aliases the frame buffer')
  })
})

describe('frame rejection — ordinary chatter must never look like a handshake', () => {
  test('random bytes of frame length are rejected (CRC does its job)', () => {
    let accepted = 0
    for (let i = 0; i < 500; i++) {
      if (parseFrame(crypto.getRandomValues(new Uint8Array(FRAME_LEN)))) accepted++
    }
    assert.equal(accepted, 0)
  })

  test('a decoded ordinary message (wrong length) is rejected', () => {
    for (const n of [0, 1, 16, 40, 42, 100]) {
      assert.equal(parseFrame(new Uint8Array(n)), null, `${n}-byte input was parsed as a frame`)
    }
  })

  test('correct MAGIC but corrupted pubkey fails the CRC', () => {
    const { pub } = genKeyPair()
    const frame = buildFrame(FRAME.OFFER, pub)
    frame[10] ^= 0xff
    assert.equal(parseFrame(frame), null)
  })

  test('correct MAGIC and body but corrupted CRC is rejected', () => {
    const { pub } = genKeyPair()
    const frame = buildFrame(FRAME.OFFER, pub)
    frame[FRAME_LEN - 1] ^= 0x01
    assert.equal(parseFrame(frame), null)
  })

  test('an unknown frame type is rejected even with a valid CRC', () => {
    // Forward compatibility check: a future 0x10 message frame must not be mistaken for a
    // key exchange by an older build. Rebuild the CRC so only the TYPE is unexpected.
    const { pub } = genKeyPair()
    const frame = buildFrame(FRAME.OFFER, pub)
    frame[4] = 0x10
    const body = frame.subarray(0, 37)
    const crc = crc32(body)
    frame[37] = (crc >>> 24) & 0xff
    frame[38] = (crc >>> 16) & 0xff
    frame[39] = (crc >>> 8) & 0xff
    frame[40] = crc & 0xff
    assert.equal(parseFrame(frame), null, 'an unknown frame type was accepted as a handshake')
  })

  test('a frame with the MAGIC bytes shifted by one is rejected', () => {
    const { pub } = genKeyPair()
    const frame = buildFrame(FRAME.OFFER, pub)
    const shifted = new Uint8Array(FRAME_LEN)
    shifted.set(frame.subarray(0, FRAME_LEN - 1), 1)
    assert.equal(parseFrame(shifted), null)
  })

  // The CRC is a 32-bit check over a 37-byte body, so a random collision is ~2^-32. This
  // asserts the odds hold in practice rather than trusting the arithmetic.
  test('flipping any single bit in the body is always caught', () => {
    // parseFrame warns on every CRC rejection — that logging is the point of the function, but
    // ~40 identical lines here would bury a real failure. Silence it for this test only.
    const warn = console.warn
    console.warn = () => {}
    try {
      const { pub } = genKeyPair()
      for (let bit = 0; bit < 37 * 8; bit += 7) {
        const frame = buildFrame(FRAME.ACK, pub)
        frame[bit >> 3] ^= 1 << (bit & 7)
        assert.equal(parseFrame(frame), null, `bit ${bit} flip was not detected`)
      }
    } finally {
      console.warn = warn
    }
  })
})

// Local CRC32 (IEEE) used only to forge a deliberately-invalid-type frame above.
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    let x = (c ^ bytes[i]) & 0xff
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1
    c = x ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}
