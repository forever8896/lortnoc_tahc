// The reader-policy engine (shared/policy.mjs) and the web frame (shared/webframe.mjs).
// Ported from the research prototype (research-tokyo/policy-proto, 28 tests) onto the real modular
// engine. Imports the real source — never a copy (test/README.md).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compile, open, parse, leaves, satisfied, honesty } from '../../shared/policy.mjs'
import { genKeyPair } from '../../shared/keys.mjs'
import { parseXFrame } from '../../shared/xframe.mjs'
import {
  sealMessage, openMessage, inspect, canonicalCover, presentCover, hasMarker, MARKER,
} from '../../shared/webframe.mjs'
import { normalisePassphrase, generatePassphrase } from '../../shared/checks/passphrase.mjs'

// Tiny Argon2 params so exhaustive sweeps run in seconds. Production uses KDF_PROFILES.
const FAST = [{ t: 1, m: 64, p: 1 }, { t: 1, m: 128, p: 1 }]
const enc = new TextEncoder()
const MSG = enc.encode('meet at the market at 7, bring the list!')
const alice = genKeyPair(), bob = genKeyPair(), mallory = genKeyPair()

const P = {
  pub: { check: 'public' },
  pw: (passphrase, profile = 0) => ({ check: 'passphrase', passphrase, profile }),
  rc: (...ks) => ({ check: 'recipients', recipients: ks.map((k) => k.pub) }),
}

const POLICIES = {
  public: P.pub,
  passphrase: P.pw('blue door'),
  'recipients[alice,bob]': P.rc(alice, bob),
  'OR(passphrase, recipients[alice])': { or: [P.pw('blue door'), P.rc(alice)] },
  'AND(passphrase, recipients[alice])': { and: [P.pw('blue door'), P.rc(alice)] },
  'AND(OR(pass1, rcpt[alice]), OR(pass2, rcpt[bob]), public)': {
    and: [{ or: [P.pw('one'), P.rc(alice)] }, { or: [P.pw('two'), P.rc(bob)] }, P.pub],
  },
  'OR(AND(same, rcpt[alice]), AND(same, rcpt[bob]))': {
    or: [{ and: [P.pw('same'), P.rc(alice)] }, { and: [P.pw('same'), P.rc(bob)] }],
  },
}

/** Reader credentials for leaf subset `mask` (bit i = leaf i satisfied). One msgKey per reader, so
 *  recipients leaves are satisfied by WHO the reader is, and ground truth accounts for that. */
function readerFor(policy, mask) {
  const passphrases = []
  let msgKey = mallory, usePublic = false
  leaves(policy).forEach(({ node }, i) => {
    const on = (mask >> i) & 1
    if (node.check === 'passphrase') passphrases.push(on ? node.passphrase : `wrong-${i}`)
    if (node.check === 'recipients' && on) msgKey = String(node.recipients[0]) === String(alice.pub) ? alice : bob
    if (node.check === 'public' && on) usePublic = true
  })
  return { passphrases, msgKey, usePublic, kdfProfiles: FAST }
}
function expected(policy, r) {
  return satisfied(policy, (node) => {
    if (node.check === 'recipients') return node.recipients.some((k) => String(k) === String(r.msgKey.pub))
    if (node.check === 'passphrase') return r.passphrases.includes(node.passphrase)
    return r.usePublic
  })
}

describe('every assignment of every policy: opens iff satisfied', () => {
  for (const [name, policy] of Object.entries(POLICIES)) {
    test(name, async () => {
      const payload = await compile(policy, MSG, { kdfProfiles: FAST })
      let opened = 0
      for (let mask = 0; mask < 1 << leaves(policy).length; mask++) {
        const r = readerFor(policy, mask)
        const got = await open(payload, r)
        if (expected(policy, r)) (assert.deepEqual(got, MSG, `mask ${mask.toString(2)} should open`), opened++)
        else assert.equal(got, null, `mask ${mask.toString(2)} must NOT open`)
      }
      assert.ok(opened > 0)
    })
  }
})

describe('fails closed', () => {
  test('every single-bit flip anywhere in the payload is refused', async () => {
    const policy = POLICIES['OR(passphrase, recipients[alice])']
    const payload = await compile(policy, MSG, { kdfProfiles: FAST })
    const full = { passphrases: ['blue door'], msgKey: alice, kdfProfiles: FAST }
    assert.deepEqual(await open(payload, full), MSG)
    for (let i = 0; i < payload.length; i++) {
      const t = payload.slice()
      t[i] ^= 0x01
      assert.equal(await open(t, full), null, `flip at byte ${i} opened`)
    }
  })
  test('the squeezed flag is bound into the tag', async () => {
    const payload = await compile(P.pub, MSG, { squeezed: false })
    assert.deepEqual(await open(payload, {}), MSG)
    assert.equal(await open(payload, { squeezed: true }), null)
  })
  test('truncated and random payloads return null and never throw', async () => {
    const payload = await compile(P.pw('blue door'), MSG, { kdfProfiles: FAST })
    for (let n = 0; n < payload.length; n++)
      assert.equal(await open(payload.subarray(0, n), { passphrases: ['blue door'], kdfProfiles: FAST }), null)
    for (let i = 0; i < 200; i++)
      assert.equal(await open(crypto.getRandomValues(new Uint8Array(60)), { passphrases: ['x'], kdfProfiles: FAST }), null)
  })
  test('a tag this version does not know parses as unsupported, and never opens', async () => {
    const payload = await compile(P.pub, MSG)
    const t = payload.slice()
    t[8] = (2 << 5) | 31 // LEAF with an unassigned tag
    assert.equal(parse(t).unsupported, 'unknown:31')
    assert.equal(await open(t, {}), null)
  })
})

describe('adversarial findings, pinned', () => {
  test('one passphrase in two leaves still gets two distinct masks (path binding)', async () => {
    // Without path binding, w1⊕w2 = share_b⊕share_c and holding one recipient share reveals the other.
    const policy = POLICIES['OR(AND(same, rcpt[alice]), AND(same, rcpt[bob]))']
    const payload = await compile(policy, MSG, { kdfProfiles: FAST })
    const p = parse(payload)
    assert.notDeepEqual(p.material.get('0,0'), p.material.get('1,0'))
    // and each branch still opens on its own
    assert.deepEqual(await open(payload, { passphrases: ['same'], msgKey: alice, kdfProfiles: FAST }), MSG)
    assert.deepEqual(await open(payload, { passphrases: ['same'], msgKey: bob, kdfProfiles: FAST }), MSG)
    assert.equal(await open(payload, { passphrases: ['same'], msgKey: mallory, kdfProfiles: FAST }), null)
  })
  test('secrets never appear in the public shape', async () => {
    const payload = await compile({ or: [P.pw('correct horse battery'), P.rc(alice)] }, MSG, { kdfProfiles: FAST })
    const hex = Buffer.from(payload).toString('hex')
    assert.ok(!Buffer.from(payload).includes(Buffer.from('correct horse')))
    assert.ok(!hex.includes(Buffer.from(alice.pub).toString('hex')), 'recipient key leaked')
  })
  test('honesty chips come from the checks\' declared flags', () => {
    assert.deepEqual(honesty(P.pub), { obfuscationOnly: true, gateCanRead: true, offlineGuessable: false })
    assert.equal(honesty(P.pw('x')).offlineGuessable, true)
    assert.equal(honesty({ and: [P.pub, P.pw('x')] }).obfuscationOnly, false)
    assert.equal(honesty(P.rc(alice)).gateCanRead, false)
  })
  test('policy limits are enforced', async () => {
    await assert.rejects(compile({ or: [P.pub] }, MSG), /2\.\.8/)
    const deep = { and: [{ or: [{ and: [{ or: [P.pub, P.pub] }, P.pub] }, P.pub] }, P.pub] }
    await assert.rejects(compile(deep, MSG), /too deep/)
    await assert.rejects(compile({ check: 'nope' }, MSG), /unknown check/)
  })
})

describe('passphrase', () => {
  test('case and spacing never make it wrong', async () => {
    assert.equal(normalisePassphrase('  Blue   DOOR '), 'blue door')
    const payload = await compile(P.pw('Blue Door'), MSG, { kdfProfiles: FAST })
    assert.deepEqual(await open(payload, { passphrases: ['  blue   door'], kdfProfiles: FAST }), MSG)
  })
  test('generated passphrases are five BIP39 words (55 bits)', () => {
    const a = generatePassphrase(), b = generatePassphrase()
    assert.equal(a.split(' ').length, 5)
    assert.notEqual(a, b)
  })
  test('the hint is public and shown; the passphrase is not', async () => {
    const f = await sealMessage('hi', { check: 'passphrase', passphrase: 'secret words', hint: 'our street' }, { kdfProfiles: FAST })
    assert.deepEqual(inspect(f).checks, ['Passphrase · hint: our street'])
    assert.ok(!Buffer.from(f).includes(Buffer.from('secret words')))
  })
})

describe('web frame', () => {
  test('seal → open round trip, squeezed and not', async () => {
    for (const text of ['hi', 'meet at the market at seven, bring the list and the good knife'.repeat(3)]) {
      const f = await sealMessage(text, { or: [P.pw('blue door'), P.rc(bob)] }, { kdfProfiles: FAST })
      assert.equal(await openMessage(f, { passphrases: ['blue door'], kdfProfiles: FAST }), text)
      assert.equal(await openMessage(f, { msgKey: bob, kdfProfiles: FAST }), text)
      assert.equal(await openMessage(f, { msgKey: alice, kdfProfiles: FAST }), null)
    }
  })
  test('inspect needs no keys and reports what the post asks for', async () => {
    const f = await sealMessage('hi', { or: [P.pw('x'), P.rc(alice, bob)] }, { kdfProfiles: FAST })
    const i = inspect(f)
    assert.deepEqual(i.checks, ['Passphrase', '2 named people'])
    assert.deepEqual(i.needs.sort(), ['passphrase', 'recipients'])
    assert.equal(inspect(new Uint8Array([0x20, 1, 2, 3])), null, 'not a web frame')
  })
  test('a v2 X reader rejects a web frame by mode instead of misreading it', async () => {
    assert.equal(parseXFrame(await sealMessage('hi', P.pub)), null)
  })
  test('canonicalCover is the identity on anything the codec emits', () => {
    for (let i = 0; i < 200; i++) {
      const words = Array.from({ length: 1 + (i % 30) }, () =>
        Array.from({ length: 1 + (i % 9) }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join(''))
      const cover = words.join(' ')
      assert.equal(canonicalCover(cover), cover)
    }
  })
  test('canonicalCover repairs what websites do to text', () => {
    const cover = 'the recipe calls for more salt than you think'
    const mangled = [
      'The recipe calls for more salt than you think.',
      '  the recipe\ncalls for  more salt\tthan you think ',
      'the recipe calls for more salt than you think #lortnoctahc',
      '#LortnocTahc the recipe calls for more salt than you think!!',
      'the recipe calls​ for more salt than you­ think',
      'THE RECIPE CALLS FOR MORE SALT THAN YOU THINK',
    ]
    for (const m of mangled) assert.equal(canonicalCover(m), cover, JSON.stringify(m))
  })
  test('marker is optional (high-risk mode drops it) and detectable', () => {
    assert.equal(presentCover('a b', { marker: false }), 'a b')
    assert.equal(presentCover('a b'), `a b ${MARKER}`)
    assert.ok(hasMarker('some text #LortnocTahc'))
    assert.ok(!hasMarker('some text'))
  })
})

describe('deep scan pre-filter', async () => {
  const { looksLikeCover } = await import('../../shared/webframe.mjs')
  // Real cover text from the booth recording (codec output posted through Telegram).
  const COVER = 'im the happiest person that loves nothing when looking good that will come back you should remember those past pictures of other dogs getting hit are that of an eagle to me like no pain what does they think im out you'
  test('real cover text is a candidate, including what sites do to it', () => {
    assert.ok(looksLikeCover(COVER))
    assert.ok(looksLikeCover(COVER + '.'), 'a trailing full stop')
    assert.ok(looksLikeCover('Im' + COVER.slice(2)), 'a capitalised first word')
    assert.ok(looksLikeCover(COVER + ' #lortnoctahc'), 'old tagged posts still found')
  })
  test('ordinary human comments are not', () => {
    for (const c of [
      'I made this last night and it was delicious! Added a bit more cumin than the recipe says, and served it with crusty bread. My kids loved it, will definitely make again.',
      'Can I use red lentils instead of green ones? Also, how long does it keep in the fridge? Thanks so much for sharing this recipe with us, it looks amazing.',
      'great recipe',
    ]) assert.equal(looksLikeCover(c), false, c.slice(0, 40))
  })
})
