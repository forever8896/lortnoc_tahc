// The gate (gate/core.mjs) + the attested path through the engine, with the real code end to end:
// shared/policy → shared/gateclient → gate/core → shared/checks/after. No network — `post` calls
// the gate object directly, exactly what gate/server.mjs does per request.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../../gate/core.mjs'
import { gateDepositor, gateReleaser } from '../../shared/gateclient.mjs'
import { sealMessage, openMessage, inspect } from '../../shared/webframe.mjs'
import { parse } from '../../shared/policy.mjs'
import { sealTo, openBox, CTX } from '../../shared/gatebox.mjs'
import { genKeyPair, toHex } from '../../shared/keys.mjs'

const FAST = [{ t: 1, m: 64, p: 1 }]
const HOUR = 3600_000

function harness() {
  const gate = createGate()
  const post = async (path, body) => {
    try {
      return path === '/deposit' ? gate.deposit(body) : await gate.release(body)
    } catch (e) {
      return { error: e.message, status: e.status }
    }
  }
  const denials = []
  const shares = [] // every share handed to the gate, so tests can prove none travels in a post
  const depositor = gateDepositor({ gatePub: gate.pub, post })
  return {
    gate,
    shares,
    deposit: (leaf, share, ctx) => (shares.push(share.slice()), depositor(leaf, share, ctx)),
    release: gateReleaser({ post, onDeny: (d) => denials.push(d) }),
    denials,
    post,
  }
}

describe('gate + the `after` check', () => {
  test('a past time opens; the share never appears in the post', async () => {
    const h = harness()
    const f = await sealMessage('see you then', { check: 'after', after: Date.now() - HOUR }, { deposit: h.deposit })
    assert.equal(await openMessage(f, { release: h.release }), 'see you then')
    assert.equal(h.shares.length, 1)
    assert.ok(!Buffer.from(f).includes(Buffer.from(h.shares[0])), 'the gate-held share is inside the post')
    assert.equal(inspect(f).honesty.gateCanRead, true, 'an after-only post IS gate-readable — the chip must say so')
  })

  test('a future time stays shut, and the reader is told when', async () => {
    const h = harness()
    const when = Date.now() + HOUR
    const f = await sealMessage('not yet', { check: 'after', after: when }, { deposit: h.deposit })
    assert.equal(await openMessage(f, { release: h.release }), null)
    assert.equal(h.denials[0].deny, 'not yet')
    assert.equal(h.denials[0].retryAt, Math.floor(when / 1000) * 1000)
    assert.match(inspect(f).checks[0], /^Opens after \d{4}-\d\d-\d\d \d\d:\d\d UTC$/)
  })

  test('a post edited to claim 1970 gets nothing: its shape no longer matches the deposit', async () => {
    const h = harness()
    const f = await sealMessage('not yet', { check: 'after', after: Date.now() + HOUR }, { deposit: h.deposit })
    const forged = f.slice()
    // shape starts at byte 1 (frame) + 8 (nonce); leaf byte, then 4 bytes of unlock time
    forged.set([0, 0, 0, 1], 1 + 8 + 1)
    assert.match(inspect(forged).checks[0], /1970/, 'the forged post now claims 1970')
    assert.equal(await openMessage(forged, { release: h.release }), null)
    // Refused because the edit changed the policy hash the deposit is tied to — and a release
    // request carries no params at all, so the unlock time the gate applies is only ever its own.
    assert.equal(h.denials.at(-1).deny, 'reference does not belong to this post')
  })

  test('a reference pasted into a different post is refused', async () => {
    const h = harness()
    const a = await sealMessage('a', { check: 'after', after: Date.now() - HOUR }, { deposit: h.deposit })
    const refA = parse(a.subarray(1)).material.get('')
    const r = await h.post('/release', { ref: toHex(refA), readerPub: toHex(genKeyPair().pub), policyHash: '00'.repeat(32) })
    assert.equal(r.deny, 'reference does not belong to this post')
  })

  test('AND(after, passphrase): the gate alone cannot read it, and both are needed', async () => {
    const h = harness()
    const policy = { and: [{ check: 'after', after: Date.now() - HOUR }, { check: 'passphrase', passphrase: 'blue door' }] }
    const f = await sealMessage('both', policy, { deposit: h.deposit, kdfProfiles: FAST })
    assert.equal(inspect(f).honesty.gateCanRead, false)
    assert.equal(await openMessage(f, { release: h.release, kdfProfiles: FAST }), null, 'gate share alone')
    assert.equal(await openMessage(f, { passphrases: ['blue door'], kdfProfiles: FAST }), null, 'passphrase alone')
    assert.equal(await openMessage(f, { release: h.release, passphrases: ['blue door'], kdfProfiles: FAST }), 'both')
  })

  test('OR(after-in-future, passphrase): the passphrase is the alternative path', async () => {
    const h = harness()
    const policy = { or: [{ check: 'after', after: Date.now() + HOUR }, { check: 'passphrase', passphrase: 'blue door' }] }
    const f = await sealMessage('either', policy, { deposit: h.deposit, kdfProfiles: FAST })
    assert.equal(await openMessage(f, { release: h.release, passphrases: ['blue door'], kdfProfiles: FAST }), 'either')
  })
})

describe('gate hygiene', () => {
  test('a share not sealed to this gate is refused', () => {
    const { gate } = harness()
    const box = sealTo(genKeyPair().pub, new Uint8Array(16), CTX.deposit)
    assert.throws(() => gate.deposit({ check: 'after', params: { after: 1 }, box, policyHash: '00'.repeat(32) }), /not sealed/)
  })
  test('a deposit box cannot be replayed as a release box (context separation)', () => {
    const me = genKeyPair()
    const box = sealTo(me.pub, new Uint8Array(16).fill(7), CTX.deposit)
    assert.equal(openBox(me.priv, me.pub, box, CTX.release), null)
    assert.deepEqual(openBox(me.priv, me.pub, box, CTX.deposit), new Uint8Array(16).fill(7))
  })
  test('the release is sealed to the reader who asked, not anyone who copies it', async () => {
    const h = harness()
    const f = await sealMessage('x', { check: 'after', after: Date.now() - HOUR }, { deposit: h.deposit })
    const p = parse(f.subarray(1))
    const alice = genKeyPair(), eve = genKeyPair()
    const r = await h.post('/release', { ref: toHex(p.material.get('')), readerPub: toHex(alice.pub), policyHash: toHex(p.policyHash) })
    assert.ok(openBox(alice.priv, alice.pub, r.box, CTX.release))
    assert.equal(openBox(eve.priv, eve.pub, r.box, CTX.release), null)
  })
  test('non-attested checks and junk are refused at deposit', () => {
    const { gate } = harness()
    assert.throws(() => gate.deposit({ check: 'passphrase', params: {}, box: {}, policyHash: '00'.repeat(32) }), /unknown attested/)
    assert.throws(() => gate.deposit({ check: 'after', params: { after: 1 }, box: {}, policyHash: 'zz' }), /policyHash/)
  })
  test('the gate key persists across restarts of the same database', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'gate-'))
    const a = createGate({ dbPath: join(dir, 'g.sqlite') })
    const pub = a.pub
    a.close()
    const b = createGate({ dbPath: join(dir, 'g.sqlite') })
    assert.equal(b.pub, pub, 'a restart must not change the key every pending deposit was sealed to')
    b.close()
    rmSync(dir, { recursive: true })
  })
})
