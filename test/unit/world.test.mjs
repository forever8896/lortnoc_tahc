// The `human` check (World ID) through the real engine, the real gate and the real gate/world.mjs
// checks. World's two network verdicts are injected (test/lib/world-fake.mjs); the live network path
// is proven separately by gate/world-roundtrip.mjs against World's simulator.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../../gate/core.mjs'
import { gateDepositor, gateReleaser } from '../../shared/gateclient.mjs'
import { sealMessage, openMessage, inspect } from '../../shared/webframe.mjs'
import { fakeWorld, proofFor, proofFrom } from '../lib/world-fake.mjs'
import { confirmed } from '../../gate/world.mjs'

const FAST = [{ t: 1, m: 64, p: 1 }]

function harness(worldOpts, over) {
  const gate = createGate({ world: fakeWorld(worldOpts) })
  const post = async (path, body) => {
    try {
      if (path === '/deposit') return gate.deposit(body)
      if (path === '/challenge') return gate.challenge(body)
      return await gate.release(body)
    } catch (e) {
      return { error: e.message }
    }
  }
  const denials = []
  return {
    gate, post, denials,
    deposit: gateDepositor({ gatePub: gate.pub, post }),
    release: gateReleaser({ post, onDeny: (d) => denials.push(d), proofFor: proofFor(over) }),
  }
}

const HUMAN = { check: 'human' }

describe('human (World ID) — the happy path', () => {
  test('a verified human opens it; the chips say what is true', async () => {
    const h = harness()
    const f = await sealMessage('humans only', HUMAN, { deposit: h.deposit })
    assert.deepEqual(inspect(f).checks, ['Verified human (World ID)'])
    assert.equal(inspect(f).honesty.gateCanRead, true)
    assert.equal(await openMessage(f, { release: h.release }), 'humans only')
  })
  test('World ID OR passphrase: the alternative path opens without World ID', async () => {
    const h = harness({ chain: { ok: false, verdicts: ['invalid'] } }) // World says no…
    const f = await sealMessage('either', { or: [HUMAN, { check: 'passphrase', passphrase: 'blue door' }] },
      { deposit: h.deposit, kdfProfiles: FAST })
    assert.equal(await openMessage(f, { release: h.release, passphrases: ['blue door'], kdfProfiles: FAST }), 'either')
  })
  test('World ID AND passphrase: the gate alone cannot read it', async () => {
    const h = harness()
    const f = await sealMessage('both', { and: [HUMAN, { check: 'passphrase', passphrase: 'blue door' }] },
      { deposit: h.deposit, kdfProfiles: FAST })
    assert.equal(inspect(f).honesty.gateCanRead, false)
    assert.equal(await openMessage(f, { release: h.release, kdfProfiles: FAST }), null)
    assert.equal(await openMessage(f, { release: h.release, passphrases: ['blue door'], kdfProfiles: FAST }), 'both')
  })
  test('each post gets its own action, so one human can read many gated posts', async () => {
    const h = harness()
    const a = await sealMessage('a', HUMAN, { deposit: h.deposit })
    const b = await sealMessage('b', HUMAN, { deposit: h.deposit })
    const actions = []
    const spy = async (path, body) => {
      const r = await h.post(path, body)
      if (path === '/challenge') actions.push(r.request.action)
      return r
    }
    const release = gateReleaser({ post: spy, proofFor: proofFor() })
    assert.equal(await openMessage(a, { release }), 'a')
    assert.equal(await openMessage(b, { release }), 'b')
    assert.notEqual(actions[0], actions[1])
  })
})

describe('human (World ID) — every refusal the gate itself must make', () => {
  // Each case forges one field of an otherwise valid proof; World's verdicts say "valid" throughout,
  // so the refusal can ONLY come from our own checks.
  const cases = [
    ['proof for another post (signal)', { response: { signal_hash: '0x00' + 'ab'.repeat(31) } }, /another post or reader/],
    ['another action', { top: { action: 'lortnoc-read-0000000000000000' } }, /another post/],
    ['wrong environment', { top: { environment: 'production' } }, /request was for staging/],
    ['not protocol 4.0', { top: { protocol_version: '3.0' } }, /4\.0/],
    ['a nonce the gate never issued', { top: { nonce: '0x00' + '12'.repeat(31) } }, /not issued/],
    ['wrong credential type', { response: { identifier: 'passport' } }, /needs proof_of_human/],
    ['malformed proof', { response: { proof: ['1'] } }, /malformed/],
  ]
  for (const [name, over, why] of cases) {
    test(name, async () => {
      const h = harness({}, over)
      const f = await sealMessage('no', HUMAN, { deposit: h.deposit })
      assert.equal(await openMessage(f, { release: h.release }), null)
      assert.match(h.denials.at(-1).deny, why)
    })
  }
  test('World Chain says invalid → refused', async () => {
    const h = harness({ chain: { ok: false, verdicts: ['invalid', 'valid', 'valid'] } })
    const f = await sealMessage('no', HUMAN, { deposit: h.deposit })
    assert.equal(await openMessage(f, { release: h.release }), null)
    assert.match(h.denials.at(-1).deny, /World Chain verifier did not confirm/)
  })
  test("World's verify API refuses → refused even if the chain agrees", async () => {
    const h = harness({ api: { ok: false, reason: 'verification_error' } })
    const f = await sealMessage('no', HUMAN, { deposit: h.deposit })
    assert.equal(await openMessage(f, { release: h.release }), null)
    assert.match(h.denials.at(-1).deny, /verify API refused/)
  })
  test('a replayed proof is refused (single-use nonce)', async () => {
    const h = harness()
    const f = await sealMessage('once', HUMAN, { deposit: h.deposit })
    let captured
    const capture = async (path, body) => {
      if (path === '/release') captured = body
      return h.post(path, body)
    }
    assert.equal(await openMessage(f, { release: gateReleaser({ post: capture, proofFor: proofFor() }) }), 'once')
    const again = await h.post('/release', captured) // the exact same request, replayed
    assert.equal(again.deny, 'nonce already used')
  })
  test('a proof requested by one reader cannot be redeemed by another', async () => {
    const h = harness()
    const f = await sealMessage('mine', HUMAN, { deposit: h.deposit })
    const { parse } = await import('../../shared/policy.mjs')
    const { genKeyPair, toHex } = await import('../../shared/keys.mjs')
    const p = parse(f.subarray(1))
    const alice = toHex(genKeyPair().pub), eve = toHex(genKeyPair().pub)
    const base = { ref: toHex(p.material.get('')), policyHash: toHex(p.policyHash) }
    const c = await h.post('/challenge', { ...base, readerPub: alice })
    const r = await h.post('/release', { ...base, readerPub: eve, proof: proofFrom(c.request) })
    assert.match(r.deny, /different reader|another post or reader/)
  })
  test('a gate without World configured says so instead of pretending', async () => {
    const gate = createGate()
    assert.ok(!gate.checks.includes('human'))
  })
})

describe('the on-chain verdict rule', () => {
  test('two valid and none invalid — one RPC is never enough, one "invalid" always vetoes', () => {
    assert.equal(confirmed(['valid', 'valid', 'valid']), true)
    assert.equal(confirmed(['valid', 'valid', 'unknown']), true, 'one RPC down must not lock readers out')
    assert.equal(confirmed(['valid', 'unknown', 'unknown']), false, 'a single RPC saying valid is not proof')
    assert.equal(confirmed(['valid', 'valid', 'invalid']), false, 'any revert vetoes')
    assert.equal(confirmed([]), false)
  })
})

describe('nationality (World ID Identity Check, preview)', () => {
  const UKR = { check: 'human', preset: 'identity', country: 'UKR' }
  test('the challenge asks for nationality UKR; a matching passport opens it', async () => {
    const h = harness()
    const f = await sealMessage('for ukrainians', UKR, { deposit: h.deposit })
    assert.deepEqual(inspect(f).checks, ['Citizens of UKR (World ID passport)'])
    const { parse } = await import('../../shared/policy.mjs')
    const { genKeyPair, toHex } = await import('../../shared/keys.mjs')
    const p = parse(f.subarray(1))
    const c = await h.post('/challenge', { ref: toHex(p.material.get('')), readerPub: toHex(genKeyPair().pub), policyHash: toHex(p.policyHash) })
    assert.deepEqual(c.request.attributes, [{ type: 'nationality', value: 'UKR' }])
    assert.equal(await openMessage(f, { release: h.release }), 'for ukrainians')
  })
  for (const [name, over, why] of [
    ['World ID did not attest the nationality', { top: { identity_attested: false } }, /did not attest/],
    ['no attestation at all', { top: { identity_attested: undefined } }, /did not attest/],
    ['a Proof of Human credential instead of a passport', { response: { identifier: 'proof_of_human', issuer_schema_id: 1 } }, /passport/],
  ]) {
    test(`refused: ${name}`, async () => {
      const h = harness({}, over)
      const f = await sealMessage('x', UKR, { deposit: h.deposit })
      assert.equal(await openMessage(f, { release: h.release }), null)
      assert.match(h.denials.at(-1).deny, why)
    })
  }
  test('a proof obtained for ANOTHER post cannot open this one (no signal — the nonce binds it)', async () => {
    const h = harness()
    const a = await sealMessage('a', UKR, { deposit: h.deposit })
    const b = await sealMessage('b', UKR, { deposit: h.deposit })
    const { parse } = await import('../../shared/policy.mjs')
    const { genKeyPair, toHex } = await import('../../shared/keys.mjs')
    const pa = parse(a.subarray(1)), pb = parse(b.subarray(1))
    const me = toHex(genKeyPair().pub)
    const c = await h.post('/challenge', { ref: toHex(pa.material.get('')), readerPub: me, policyHash: toHex(pa.policyHash) })
    const r = await h.post('/release', { ref: toHex(pb.material.get('')), readerPub: me, policyHash: toHex(pb.policyHash), proof: proofFrom(c.request) })
    // Refused either way: nonces live in each post's own gate state, so B has never seen A's nonce.
    assert.match(r.deny, /another post|not issued by this gate/)
  })
  test('a country must be a 3-letter ISO code', async () => {
    const h = harness()
    await assert.rejects(sealMessage('x', { check: 'human', preset: 'identity', country: 'UA' }, { deposit: h.deposit }), /3-letter/)
  })
})

describe('human (World ID) — several environments on one gate (sandbox for phones, staging for the simulator)', () => {
  const ref = 'ab'.repeat(8)
  const reader = 'cd'.repeat(32)
  test('the first is the default; staging only when asked; anything else falls back to the default', () => {
    const w = fakeWorld({ env: 'sandbox,staging' })
    const st = new Map()
    assert.deepEqual(w.envs, ['sandbox', 'staging'])
    assert.equal(w.challenge(ref, reader, st).environment, 'sandbox')
    assert.equal(w.challenge(ref, reader, st, 'poh', undefined, undefined, 'staging').environment, 'staging')
    assert.equal(w.challenge(ref, reader, st, 'poh', undefined, undefined, 'production').environment, 'sandbox')
  })
  test('a proof must come from the environment its request was issued for', async () => {
    const w = fakeWorld({ env: 'sandbox,staging' })
    const st = new Map()
    const q = w.challenge(ref, reader, st, 'poh', undefined, undefined, 'staging')
    assert.equal((await w.verify(proofFrom(q), { ref, readerPub: reader, action: q.action }, st)).ok, true)
    const q2 = w.challenge(ref, reader, st)
    const forged = proofFrom(q2, { top: { environment: 'staging' } })
    assert.match((await w.verify(forged, { ref, readerPub: reader, action: q2.action }, st)).deny, /request was for sandbox/)
  })
  test('an unknown environment name is a configuration error, not a silent default', () => {
    assert.throws(() => fakeWorld({ env: 'prod' }), /WORLD_ENV/)
  })
})
