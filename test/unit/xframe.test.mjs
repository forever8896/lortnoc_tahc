// The X wire format v2 (PRD-x-extension.md §6). Imports the real buildXFrames/parseXFrame.
//
// Same emphasis as handshake.test.mjs, for the same reason: framing decides "is this tweet ours,
// somebody else's, or ordinary chatter?" and every wrong answer is silent. On X there is one
// extra failure that does not exist on Telegram — a THREAD with a missing part. PRD §6 requires
// that to fail closed (render the cover text untouched, never partial plaintext), so reassembly
// gaps get as much attention here as the rejection paths.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from '../lib/env.mjs'

import {
  buildXFrame,
  buildXFrames,
  parseXFrame,
  ThreadCollector,
  X_MODE,
  MAX_PARTS,
  HASHTAG,
  appendTag,
  stripTag,
} from '../../shared/xframe.mjs'
import { derivePublicChannelKey, encryptBytes, tryDecryptBytes } from '../../shared/keys.mjs'
import { squeezeIfSmaller, unsqueezeMaybe } from '../../shared/squeeze.mjs'

const ct = (n = 24) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff)

describe('single-post frames', () => {
  test('round-trips with the payload intact', () => {
    const p = ct()
    const f = parseXFrame(buildXFrame(X_MODE.PUBLIC, p))
    assert.ok(f)
    assert.equal(f.mode, X_MODE.PUBLIC)
    assert.equal(f.seq, 0)
    assert.equal(f.total, 1)
    assert.equal(f.threaded, false)
    assert.equal(f.tid, null)
    assert.ok(eq(f.payload, p))
  })

  test('the header is 2 bytes — the v2 saving is the point of the format', () => {
    const p = ct(24)
    assert.equal(buildXFrame(X_MODE.PUBLIC, p).length, 2 + p.length)
    // Mode nibbles are consensus; a future build must agree with these exact values.
    assert.equal(X_MODE.PUBLIC, 0x2)
    assert.equal(X_MODE.SHARED, 0x3)
    assert.equal(X_MODE.RECIPIENTS, 0x4)
  })

  test('the squeezed flag survives the round trip', () => {
    for (const squeezed of [true, false]) {
      assert.equal(parseXFrame(buildXFrame(X_MODE.PUBLIC, ct(), { squeezed })).squeezed, squeezed)
    }
  })
})

describe('threading', () => {
  test('splits into the expected number of parts and reassembles exactly', () => {
    const payload = ct(50)
    const frames = buildXFrames(X_MODE.PUBLIC, payload, { chunkBytes: 16 })
    assert.equal(frames.length, 4) // ceil(50/16)

    const c = new ThreadCollector()
    let out = null
    for (const f of frames) out = c.offer(parseXFrame(f)) ?? out
    assert.ok(eq(out, payload), 'reassembled ciphertext must equal the original')
  })

  test('threaded frames carry a 4-byte header and a shared tid', () => {
    const payload = ct(50)
    const frames = buildXFrames(X_MODE.PUBLIC, payload, { chunkBytes: 16 })
    const parsed = frames.map(parseXFrame)
    const tid = (payload[0] << 8) | payload[1]
    for (const [i, f] of parsed.entries()) {
      assert.equal(f.threaded, true)
      assert.equal(f.total, 4)
      assert.equal(f.seq, i)
      assert.equal(f.tid, tid, 'every part must agree on the thread id')
    }
  })

  test('parts arriving OUT OF ORDER still reassemble — the feed is virtualised', () => {
    const payload = ct(50)
    const frames = buildXFrames(X_MODE.PUBLIC, payload, { chunkBytes: 16 }).map(parseXFrame)
    const c = new ThreadCollector()
    let out = null
    for (const f of [frames[2], frames[0], frames[3], frames[1]]) out = c.offer(f) ?? out
    assert.ok(eq(out, payload))
  })

  test('a MISSING part never yields plaintext — fails closed (§6)', () => {
    const payload = ct(50)
    const frames = buildXFrames(X_MODE.PUBLIC, payload, { chunkBytes: 16 }).map(parseXFrame)
    const c = new ThreadCollector()
    // everything except part 2
    for (const f of [frames[0], frames[1], frames[3]]) {
      assert.equal(c.offer(f), null, 'an incomplete thread must never return a ciphertext')
    }
  })

  test('two interleaved threads do not contaminate each other', () => {
    const a = ct(40)
    const b = Uint8Array.from({ length: 40 }, (_, i) => (i * 11 + 200) & 0xff)
    const fa = buildXFrames(X_MODE.PUBLIC, a, { chunkBytes: 16 }).map(parseXFrame)
    const fb = buildXFrames(X_MODE.PUBLIC, b, { chunkBytes: 16 }).map(parseXFrame)
    const c = new ThreadCollector()
    const got = []
    for (const f of [fa[0], fb[0], fb[1], fa[1], fa[2], fb[2]]) {
      const r = c.offer(f)
      if (r) got.push(r)
    }
    assert.equal(got.length, 2)
    assert.ok(got.some((g) => eq(g, a)), 'thread A must reassemble')
    assert.ok(got.some((g) => eq(g, b)), 'thread B must reassemble')
  })

  test('a duplicate part (re-scan of the same post) is harmless', () => {
    const payload = ct(30)
    const frames = buildXFrames(X_MODE.PUBLIC, payload, { chunkBytes: 16 }).map(parseXFrame)
    const c = new ThreadCollector()
    c.offer(frames[0])
    c.offer(frames[0]) // same post seen twice — virtualisation does this constantly
    assert.ok(eq(c.offer(frames[1]), payload))
  })

  test('refuses to build more than MAX_PARTS', () => {
    assert.throws(
      () => buildXFrames(X_MODE.PUBLIC, ct(200), { chunkBytes: 4 }),
      /max 16|needs \d+ parts/,
    )
    // exactly at the limit is fine
    assert.equal(buildXFrames(X_MODE.PUBLIC, ct(64), { chunkBytes: 4 }).length, MAX_PARTS)
  })
})

describe('rejection paths — what actually breaks in the field', () => {
  test('too-short input is rejected', () => {
    assert.equal(parseXFrame(new Uint8Array(0)), null)
    assert.equal(parseXFrame(new Uint8Array(1)), null)
  })

  test('an UNKNOWN mode is ignored silently — forward compatibility (§6)', () => {
    const f = buildXFrame(X_MODE.PUBLIC, ct())
    f[0] = (0xf << 4) | (f[0] & 0x0f) // a mode this build does not know
    assert.equal(parseXFrame(f), null)
  })

  test('seq >= total is structurally impossible and rejected', () => {
    const f = buildXFrame(X_MODE.PUBLIC, ct())
    f[1] = (3 << 4) | 1 // seq 3, total 2
    assert.equal(parseXFrame(f), null)
  })

  test('the threaded flag and the part count must agree', () => {
    const f = buildXFrame(X_MODE.PUBLIC, ct()) // total 1, flag clear
    f[0] |= 0x2 // claim threaded while total is still 1
    assert.equal(parseXFrame(f), null)
  })

  test('build refuses what parse would reject', () => {
    assert.throws(() => buildXFrames(0xf, ct()), /unknown mode/)
    assert.throws(() => buildXFrames(X_MODE.PUBLIC, ct(), { chunkBytes: 0 }), /chunkBytes/)
    assert.throws(() => buildXFrames(X_MODE.PUBLIC, new Uint8Array(1)), /too short/)
  })
})

describe('hashtag pre-filter', () => {
  test('appendTag / stripTag round-trip byte-exactly', () => {
    const cover = 'quiet morning here nothing much going on today'
    assert.equal(stripTag(appendTag(cover)), cover)
  })

  test('a tweet without the tag is rejected before any decode is spent', () => {
    assert.equal(stripTag('an ordinary tweet with no marker at all'), null)
  })

  test('surrounding whitespace and tag case are tolerated', () => {
    const cover = 'some perfectly ordinary words'
    assert.equal(stripTag(`  ${cover} ${HASHTAG}  `), cover)
    assert.equal(stripTag(`${cover} ${HASHTAG.toUpperCase()}`), cover)
  })

  test('a mid-text hashtag is NOT treated as ours', () => {
    assert.equal(stripTag(`hello ${HASHTAG} world`), null)
  })

  test('a DOUBLED tag still recovers the cover text exactly', () => {
    // Not hypothetical. X duplicates a trailing `#word` when the extension inserts cover text
    // programmatically — measured live on a composer filled by real keystrokes, and a real post
    // went out reading `...at all #lortnoctahc#lortnoctahc`.
    //
    // Stripping only ONE tag would leave the other inside the recovered cover text, hand the
    // codec a word it never emitted, and fail the decode. A doubled tag would make the post
    // permanently UNREADABLE rather than untidy — which is why this is a decode-side guarantee
    // and not just an outbound cosmetic fix.
    const cover = 'quiet morning here nothing much going on today'
    assert.equal(stripTag(`${cover} ${HASHTAG}${HASHTAG}`), cover)
    assert.equal(stripTag(`${cover} ${HASHTAG} ${HASHTAG}`), cover)
    assert.equal(stripTag(`${cover}${HASHTAG}`), cover, 'X also drops the space before the tag')
    assert.equal(stripTag(`${cover} ${HASHTAG}${HASHTAG}${HASHTAG}`), cover)
  })

  test('the real broken post from 2026-08-20 recovers its cover text', () => {
    // Verbatim from the timeline. Decoding this through the live codec returned "hello world",
    // which proved the encode path was correct and the doubled tag was the only fault.
    const posted =
      'amazing are your new favorite fish dishes and these kids used about this recipe and not ' +
      'knowing exactly why every two or maybe it but not how does his fish actually stand if im ' +
      'told it still weighs far well at all #lortnoctahc#lortnoctahc'
    const cover = stripTag(posted)
    assert.ok(cover, 'the post must still be recognised as ours')
    assert.ok(!cover.includes('#'), 'no tag residue may survive into the cover text')
    assert.ok(cover.endsWith('far well at all'), `unexpected cover tail: ${cover.slice(-30)}`)
  })
})

describe('mode 1 end-to-end: squeeze -> encrypt -> frame -> parse -> decrypt -> unsqueeze', () => {
  const MSGS = [
    'no',
    'meet at 8',
    'the package is in the usual place ok',
    'call me when you land, same number as before',
    'unicode survives: café ☕ naïve', // the escape path in squeeze.mjs
  ]

  for (const real of MSGS) {
    test(`round-trips ${JSON.stringify(real)} as a single post`, () => {
      const key = derivePublicChannelKey()
      const { bytes, compressed } = squeezeIfSmaller(real)
      const frame = buildXFrame(X_MODE.PUBLIC, encryptBytes(key, bytes), { squeezed: compressed })
      const parsed = parseXFrame(frame)
      const plain = tryDecryptBytes(key, parsed.payload)
      assert.ok(plain, 'the auth tag must verify')
      assert.equal(unsqueezeMaybe(plain, parsed.squeezed), real)
    })

    test(`round-trips ${JSON.stringify(real)} as a THREAD`, () => {
      const key = derivePublicChannelKey()
      const { bytes, compressed } = squeezeIfSmaller(real)
      const cipher = encryptBytes(key, bytes)
      const frames = buildXFrames(X_MODE.PUBLIC, cipher, { squeezed: compressed, chunkBytes: 8 })
      assert.ok(frames.length > 1, 'this fixture should actually split')

      const c = new ThreadCollector()
      let out = null
      let last = null
      for (const f of frames) {
        last = parseXFrame(f)
        out = c.offer(last) ?? out
      }
      const plain = tryDecryptBytes(key, out)
      assert.ok(plain, 'the auth tag must verify after reassembly')
      assert.equal(unsqueezeMaybe(plain, last.squeezed), real)
    })
  }

  test('K_public is deterministic — every install derives the same key', () => {
    assert.ok(eq(derivePublicChannelKey(), derivePublicChannelKey()))
    assert.equal(derivePublicChannelKey().length, 64) // AES-256-SIV
  })

  test('a wrong key fails the AES-SIV tag — the tag is the detector', () => {
    const frame = buildXFrame(X_MODE.PUBLIC, encryptBytes(derivePublicChannelKey(), squeezeIfSmaller('meet at 8').bytes))
    assert.equal(tryDecryptBytes(new Uint8Array(64).fill(9), parseXFrame(frame).payload), null)
  })

  test('a thread missing its last part decrypts to NOTHING, not to a fragment', () => {
    const key = derivePublicChannelKey()
    const { bytes, compressed } = squeezeIfSmaller('call me when you land, same number as before')
    const frames = buildXFrames(X_MODE.PUBLIC, encryptBytes(key, bytes), {
      squeezed: compressed,
      chunkBytes: 8,
    })
    const c = new ThreadCollector()
    for (const f of frames.slice(0, -1)) {
      assert.equal(c.offer(parseXFrame(f)), null, 'no ciphertext until every part is present')
    }
  })
})
