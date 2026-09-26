// Sealed posts (shared/sealed.mjs): open ONLY with the right keys, and say nothing without them.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sealPost, openPost, passKey, sealedRef, SLOTS, SLOT_LEN, REF_LEN } from '../../shared/sealed.mjs'

const PASS = { check: 'passphrase', passphrase: 'river copper lantern moss eleven' }
const PASS2 = { check: 'passphrase', passphrase: 'quiet orbit maple seven tide' }
const K = passKey(PASS.passphrase)
const K2 = passKey(PASS2.passphrase)
/** A stand-in gate: remembers shares per ref, releases them to whoever the test says qualifies. */
function fakeGate() {
  const store = new Map()
  return {
    gateSeal: async (items) => {
      const ref = crypto.getRandomValues(new Uint8Array(REF_LEN))
      store.set(String(ref), items)
      return ref
    },
    release: (frame, allow) => (store.get(String(sealedRef(frame))) ?? []).filter((it) => allow(it.leaf)).map((it) => it.share),
  }
}

describe('sealed — opening', () => {
  test('a passphrase post opens with that passphrase key and nothing else', async () => {
    const f = await sealPost('meet at nine', PASS)
    assert.equal((await openPost(f, { keys: [K] })).text, 'meet at nine')
    assert.equal(await openPost(f, { keys: [K2] }), null)
    assert.equal(await openPost(f), null)
  })
  test('passphrase case and spacing do not matter', async () => {
    const f = await sealPost('x', PASS)
    assert.equal((await openPost(f, { keys: [passKey('  River COPPER lantern   moss eleven ')] })).text, 'x')
  })
  test('"anyone with lortnoc" opens for every extension, with no keys', async () => {
    const f = await sealPost('hello everyone', { check: 'public' })
    const r = await openPost(f)
    assert.equal(r.text, 'hello everyone')
    assert.equal(r.honesty.obfuscationOnly, true)
  })
  test('OR: either passphrase opens it', async () => {
    const f = await sealPost('either', { or: [PASS, PASS2] })
    assert.equal((await openPost(f, { keys: [K2] })).text, 'either')
    assert.equal((await openPost(f, { keys: [K] })).text, 'either')
  })
  test('AND: a passphrase AND a gate check — one alone is not enough', async () => {
    const g = fakeGate()
    const f = await sealPost('both', { and: [PASS, { check: 'human' }] }, { gateSeal: g.gateSeal })
    const human = g.release(f, (l) => l.check === 'human')
    assert.equal(await openPost(f, { keys: [K] }), null)
    assert.equal(await openPost(f, { gateShares: human }), null)
    assert.equal((await openPost(f, { keys: [K], gateShares: human })).text, 'both')
  })
  test('the rule is inside: a reader who opened it learns what it asked for', async () => {
    const g = fakeGate()
    const f = await sealPost('dk', { check: 'human', preset: 'identity', country: 'DNK' }, { gateSeal: g.gateSeal })
    const r = await openPost(f, { gateShares: g.release(f, () => true) })
    assert.deepEqual(r.checks, ['Citizens of DNK (World ID passport)'])
  })
  test('shares from other posts do not open this one', async () => {
    const g = fakeGate()
    const a = await sealPost('a', { check: 'human' }, { gateSeal: g.gateSeal })
    const b = await sealPost('b', { check: 'human' }, { gateSeal: g.gateSeal })
    assert.equal(await openPost(a, { gateShares: g.release(b, () => true) }), null)
  })
})

describe('sealed — says nothing without a key', () => {
  test('same length and layout whatever the rule: passphrase, public, gate, AND', async () => {
    const g = fakeGate()
    const text = 'same text'
    const lens = new Set()
    for (const p of [PASS, { check: 'public' }, { check: 'human' }, { and: [PASS, { check: 'after', after: Date.now() + 60_000 }] }, { or: [PASS, PASS2] }])
      lens.add((await sealPost(text, p, { gateSeal: g.gateSeal })).length)
    // the shape inside differs by a few bytes; nothing outside the encrypted body does
    assert.ok(Math.max(...lens) - Math.min(...lens) <= 12, [...lens].join(','))
  })
  test('no plaintext rule, country, space or hint appears in the bytes', async () => {
    const g = fakeGate()
    const f = await sealPost('x', { and: [{ ...PASS, hint: 'our street' }, { check: 'human', preset: 'identity', country: 'UKR' }] }, { gateSeal: g.gateSeal })
    const s = Buffer.from(f).toString('latin1')
    for (const leak of ['UKR', 'our street', 'passphrase', 'human']) assert.ok(!s.includes(leak), leak)
  })
  test('always the same number of slots, unused ones random', async () => {
    const a = await sealPost('x', PASS)
    const b = await sealPost('x', PASS)
    assert.notDeepEqual(a.subarray(16 + SLOT_LEN, 16 + SLOTS * SLOT_LEN), b.subarray(16 + SLOT_LEN, 16 + SLOTS * SLOT_LEN))
  })
  test('random bytes and a tampered post never open', async () => {
    assert.equal(await openPost(crypto.getRandomValues(new Uint8Array(120)), { keys: [K] }), null)
    const f = await sealPost('x', PASS)
    f[f.length - 1] ^= 1
    assert.equal(await openPost(f, { keys: [K] }), null)
  })
  test('refused: more than two passphrase/anyone rules, or anything nested deeper', async () => {
    await assert.rejects(sealPost('x', { or: [PASS, PASS2, { check: 'public' }] }), /at most 2/)
    await assert.rejects(sealPost('x', { or: [{ and: [PASS, PASS2] }, { check: 'public' }] }), /nested/)
  })
})
