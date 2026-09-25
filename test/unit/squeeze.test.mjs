// shared/squeeze.mjs — plaintext compression for stego payloads.
//
// Two things are being proven here, and the second is the one that bites.
//
//   1. Exact reversibility. Anything else corrupts the user's message with no error anywhere.
//   2. The DICTIONARY IS PINNED. The table is consensus-critical in exactly the way the HKDF
//      labels are: entries are addressed by index, so inserting one in the middle renumbers
//      every entry after it and every message squeezed under the old table silently decodes to
//      different text under the new one. No exception is thrown, no tag fails — the AES-SIV tag
//      is computed over the SQUEEZED bytes, so it verifies happily and hands back wrong words.
//      Appending is safe; inserting, reordering and deleting are not.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  squeeze,
  unsqueeze,
  squeezeIfSmaller,
  unsqueezeMaybe,
  TABLE_SIZE,
  tableChecksum,
} from '../../shared/squeeze.mjs'

describe('the dictionary is pinned', () => {
  test('table size and checksum are unchanged', () => {
    // If you APPENDED an entry, update both numbers and say so in the commit. If this failed
    // because you inserted or reordered, do not update them — undo the change.
    assert.equal(TABLE_SIZE, 126, 'dictionary size changed — see the note at the top of this file')
    assert.equal(tableChecksum(), 203524842, 'dictionary contents/order changed')
  })

  test('table fits the 128 available codes', () => {
    assert.ok(TABLE_SIZE <= 128, `table has ${TABLE_SIZE} entries; codes 0x80..0xFF give 128`)
  })
})

describe('exact reversibility', () => {
  const CASES = [
    '',
    'no',
    'a',
    'meet at 8',
    'the package is in the usual place ok',
    'call me when you land, same number as before',
    'THE PACKAGE IS SHOUTING',
    "don't panic, it's fine — really",
    'café ☕ naïve résumé',
    '日本語のテキスト',
    'ÿ raw high bytes',
    'the the the the the the the the',
    '   leading and trailing   ',
    'tabs\tand\nnewlines\r\n',
    '0123456789!@#$%^&*()_+-=[]{}|;:",.<>?/~`',
  ]

  for (const s of CASES) {
    test(`round-trips ${JSON.stringify(s)}`, () => {
      assert.equal(unsqueeze(squeeze(s)), s)
      const { bytes, compressed } = squeezeIfSmaller(s)
      assert.equal(unsqueezeMaybe(bytes, compressed), s)
    })
  }

  test('round-trips 500 random ASCII messages', () => {
    const alphabet = " abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?'-"
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(Math.random() * 60)
      let s = ''
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
      assert.equal(unsqueeze(squeeze(s)), s, `failed on ${JSON.stringify(s)}`)
    }
  })

  test('round-trips 200 random messages built from dictionary words', () => {
    // The adversarial case for a greedy longest-match coder: text made ENTIRELY of entries,
    // where a wrong match length silently shifts everything after it.
    const words = ['the', 'and', 'you', 'meet', 'call', 'tomorrow', 'ok', 'no', 'i', 'thing']
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(Math.random() * 12)
      const parts = []
      for (let j = 0; j < n; j++) parts.push(words[Math.floor(Math.random() * words.length)])
      const s = parts.join(' ')
      assert.equal(unsqueeze(squeeze(s)), s, `failed on ${JSON.stringify(s)}`)
    }
  })
})

describe('malformed input fails closed', () => {
  test('a truncated escape returns null rather than throwing', () => {
    assert.equal(unsqueeze(Uint8Array.from([0x7f])), null)
  })

  test('a code past the end of the table returns null', () => {
    assert.equal(unsqueeze(Uint8Array.from([0x80 + TABLE_SIZE])), null)
    assert.equal(unsqueeze(Uint8Array.from([0xff])), null)
  })
})

describe('it only claims a win when there is one', () => {
  test('short/incompressible text is left raw', () => {
    const { bytes, compressed } = squeezeIfSmaller('no')
    assert.equal(compressed, false)
    assert.equal(bytes.length, 2)
  })

  test('real chat messages get materially smaller', () => {
    // The whole reason this module exists: one payload byte costs ~6-11 cover characters, so
    // this ratio is the difference between a single post and a thread.
    const MSGS = [
      'meet at 8',
      'bring the thing',
      'the package is in the usual place ok',
      'call me when you land, same number as before',
    ]
    const raw = MSGS.reduce((n, m) => n + new TextEncoder().encode(m).length, 0)
    const small = MSGS.reduce((n, m) => n + squeezeIfSmaller(m).bytes.length, 0)
    assert.ok(small / raw < 0.65, `expected >35% saving, got ${(100 * (1 - small / raw)).toFixed(0)}%`)
  })
})
