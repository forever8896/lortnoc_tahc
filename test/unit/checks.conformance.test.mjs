// The conformance suite every check plugin must pass (docs/PRD-universal.md §16.3). It iterates the
// REAL registry, so a check added to shared/checks/index.mjs without a fixture here fails loudly
// instead of shipping untested. This suite is what makes "a check is one file" safe.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CHECKS, byTag } from '../../shared/checks/index.mjs'
import { compile, open, parse } from '../../shared/policy.mjs'
import { genKeyPair } from '../../shared/keys.mjs'

const FAST = [{ t: 1, m: 64, p: 1 }, { t: 1, m: 128, p: 1 }]
const MSG = new TextEncoder().encode('conformance')
const me = genKeyPair(), other = genKeyPair()

/** Per check: a spec, inputs that satisfy it, inputs that must not, and secrets that must never
 *  reach the wire. `failing: null` = the check is satisfied by everyone (declared by its flags). */
const FIXTURES = {
  public: { spec: {}, passing: {}, failing: { usePublic: false }, secrets: [] },
  passphrase: {
    spec: { passphrase: 'tangerine rocket', hint: 'fruit + space' },
    passing: { passphrases: ['Tangerine  Rocket'] },
    failing: { passphrases: ['tangerine rockets'] },
    secrets: ['tangerine rocket'],
  },
  recipients: {
    spec: { recipients: [me.pub] },
    passing: { msgKey: me },
    failing: { msgKey: other },
    secrets: [Buffer.from(me.pub).toString('hex')],
  },
}

describe('every registered check', () => {
  test('has a fixture here (a new check must add one)', () => {
    assert.deepEqual(Object.keys(CHECKS).sort(), Object.keys(FIXTURES).sort())
  })

  for (const [id, m] of Object.entries(CHECKS)) {
    const fx = FIXTURES[id]
    const node = { check: id, ...fx?.spec }

    test(`${id}: declares the whole interface`, () => {
      for (const f of ['describe', 'encodeParams', 'decodeParams', 'seal', 'readMaterial', 'open'])
        assert.equal(typeof m[f], 'function', `${id}.${f}`)
      assert.ok(Number.isInteger(m.tag) && m.tag >= 0 && m.tag < 32, 'tag fits 5 bits')
      assert.equal(byTag(m.tag), m)
      assert.ok(['inline', 'attested'].includes(m.kind))
      assert.equal(typeof m.flags, 'object', 'honesty flags declared (even if empty)')
    })

    test(`${id}: public params round-trip through the wire`, () => {
      const bytes = Uint8Array.from(m.encodeParams(node))
      const r = m.decodeParams(bytes, 0)
      assert.equal(r.at, bytes.length, 'decodeParams consumes exactly what encodeParams wrote')
      assert.deepEqual(Uint8Array.from(m.encodeParams({ ...node, ...r.params, ...fx.spec })), bytes)
    })

    test(`${id}: satisfied opens, unsatisfied does not`, async () => {
      const payload = await compile(node, MSG, { kdfProfiles: FAST })
      assert.deepEqual(await open(payload, { ...fx.passing, kdfProfiles: FAST }), MSG)
      if (fx.failing) assert.equal(await open(payload, { ...fx.failing, kdfProfiles: FAST }), null)
    })

    test(`${id}: secrets never reach the wire; describe() never leaks them`, async () => {
      const payload = await compile(node, MSG, { kdfProfiles: FAST })
      const hex = Buffer.from(payload).toString('hex')
      const label = m.describe(parse(payload).shape)
      for (const s of fx.secrets) {
        assert.ok(!Buffer.from(payload).includes(Buffer.from(s)), `${id} leaked "${s}" in bytes`)
        assert.ok(!hex.includes(s), `${id} leaked a key in hex`)
        assert.ok(!label.toLowerCase().includes(s), `${id} describe() leaked it`)
      }
    })

    test(`${id}: two posts of the same message share no material (fresh nonce)`, async () => {
      const a = parse(await compile(node, MSG, { kdfProfiles: FAST }))
      const b = parse(await compile(node, MSG, { kdfProfiles: FAST }))
      assert.notDeepEqual(a.header, b.header)
    })
  }
})
