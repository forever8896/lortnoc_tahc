// Spaces, verified members and bans — the whole story through the real engine, gate and checks,
// with World's verdicts faked (test/lib/world-fake.mjs). A "human" here is a fixed nullifier: the
// measured fact this rests on is that re-proving one World ID action yields the same nullifier
// (gate/world-roundtrip.mjs with ACTION=, 2026-09-26: "Proof verified successfully (nullifier reuse)").
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../../gate/core.mjs'
import { gateDepositor, gateReleaser } from '../../shared/gateclient.mjs'
import { sealMessage, openMessage, inspect } from '../../shared/webframe.mjs'
import { genSigner, sign, MSG, contentHash, withAuthor, readAuthor } from '../../shared/member.mjs'
import { fakeWorld, proofFor } from '../lib/world-fake.mjs'

const ALICE = '0x' + 'a1'.repeat(32), MALLORY = '0x' + 'bb'.repeat(32) // World ID nullifiers = humans
const SPACE = 'lentil-club'

function setup() {
  const gate = createGate({ world: fakeWorld() })
  const post = async (path, body) => {
    try {
      if (path === '/deposit') return gate.deposit(body)
      if (path === '/challenge') return gate.challenge(body)
      return await gate.release(body)
    } catch (e) {
      return { error: e.message, status: e.status }
    }
  }
  const owner = genSigner()
  gate.spaces.register({ space: SPACE, ownerPub: owner.pub, sig: sign(owner.priv, MSG.register(SPACE, owner.pub)) })
  /** A reader: one human (nullifier) with a member key, trying to open a post. */
  const reader = (nullifier) => {
    const key = genSigner()
    const log = { member: null, denials: [] }
    const release = gateReleaser({
      post,
      proofFor: proofFor({ response: { nullifier } }),
      extraFor: () => ({ memberPub: key.pub }),
      onRelease: (r) => (log.member = r.member ?? log.member),
      onDeny: (d) => log.denials.push(d.deny),
    })
    return { key, log, open: (f) => openMessage(f, { release }) }
  }
  const deposit = gateDepositor({ gatePub: gate.pub, post })
  const spacePost = (text) => sealMessage(text, { check: 'human', space: SPACE }, { deposit })
  const ban = (memberId, as = owner, unban = false) => {
    try {
      return gate.spaces.ban({ space: SPACE, memberId, unban, sig: sign(as.priv, MSG.ban(SPACE, memberId, unban)) })
    } catch (e) {
      return { error: e.message, status: e.status }
    }
  }
  return { gate, owner, reader, spacePost, ban }
}

describe('spaces and bans', () => {
  test('a verified human joins a space under a stable pseudonym', async () => {
    const s = setup()
    const f = await s.spacePost('welcome to the circle')
    assert.match(inspect(f).checks[0], /members of lentil-club/)
    const alice = s.reader(ALICE)
    assert.equal(await alice.open(f), 'welcome to the circle')
    assert.match(alice.log.member.memberId, /^member-[0-9a-f]{12}$/)
    // the same human re-verifying later (another post, another device) is the same member
    const again = s.reader(ALICE)
    assert.equal(await again.open(await s.spacePost('second post')), 'second post')
    assert.equal(again.log.member.memberId, alice.log.member.memberId)
  })

  test('a member can sign posts as their pseudonym; readers verify it; forgeries fail', async () => {
    const s = setup()
    const alice = s.reader(ALICE)
    await alice.open(await s.spacePost('hi'))
    const { memberId } = alice.log.member
    const text = 'bring bread on thursday'
    const h = contentHash(text)
    const att = await s.gate.spaces.attest({ space: SPACE, memberId, contentHash: h, sig: sign(alice.key.priv, MSG.authorRequest(SPACE, memberId, h)) })
    assert.ok(att.sig)
    const good = readAuthor(withAuthor(text, { space: SPACE, memberId, sig: att.sig }), s.gate.signPub)
    assert.deepEqual(good, { text, author: { space: SPACE, memberId, verified: true } })
    // Mallory copies Alice's attestation onto her own words: the hash no longer matches
    const forged = readAuthor(withAuthor('alice says hand over the keys', { space: SPACE, memberId, sig: att.sig }), s.gate.signPub)
    assert.equal(forged.author.verified, false)
    // and Mallory cannot get the gate to sign as Alice without Alice's member key
    const mallorySigner = genSigner()
    const bad = await s.gate.spaces.attest({ space: SPACE, memberId, contentHash: h, sig: sign(mallorySigner.priv, MSG.authorRequest(SPACE, memberId, h)) })
    assert.equal(bad.deny, 'not signed by this member')
  })

  test('a ban sticks: the banned human cannot re-join, even as a "new account"', async () => {
    const s = setup()
    const mallory = s.reader(MALLORY)
    await mallory.open(await s.spacePost('hello'))
    const { memberId } = mallory.log.member
    assert.deepEqual(s.ban(memberId), { space: SPACE, memberId, banned: true })
    // a fresh World App account is still the same human → the same nullifier in this space
    const newAccount = s.reader(MALLORY)
    assert.equal(await newAccount.open(await s.spacePost('members only')), null)
    assert.match(newAccount.log.denials.at(-1), /banned from this space/)
    // …and cannot post as a verified member any more
    const h = contentHash('x')
    const att = await s.gate.spaces.attest({ space: SPACE, memberId, contentHash: h, sig: sign(mallory.key.priv, MSG.authorRequest(SPACE, memberId, h)) })
    assert.match(att.deny, /banned/)
    // everyone else is unaffected
    const alice = s.reader(ALICE)
    assert.equal(await alice.open(await s.spacePost('still here')), 'still here')
  })

  test('only the owner can ban; an unban restores access', async () => {
    const s = setup()
    const alice = s.reader(ALICE)
    await alice.open(await s.spacePost('hi'))
    const { memberId } = alice.log.member
    assert.equal(s.ban(memberId, genSigner()).status, 403)
    s.ban(memberId)
    assert.equal(await s.reader(ALICE).open(await s.spacePost('x')), null)
    s.ban(memberId, s.owner, true)
    assert.equal(await s.reader(ALICE).open(await s.spacePost('back')), 'back')
  })

  test('pseudonyms differ between spaces — a person cannot be followed across them', async () => {
    const s = setup()
    const other = genSigner()
    s.gate.spaces.register({ space: 'book-club', ownerPub: other.pub, sig: sign(other.priv, MSG.register('book-club', other.pub)) })
    const deposit = gateDepositor({ gatePub: s.gate.pub, post: async (p, b) => (p === '/deposit' ? s.gate.deposit(b) : null) })
    const a1 = s.reader(ALICE), a2 = s.reader(ALICE)
    await a1.open(await s.spacePost('lentils'))
    await a2.open(await sealMessage('books', { check: 'human', space: 'book-club' }, { deposit }))
    assert.notEqual(a1.log.member.memberId, a2.log.member.memberId)
  })

  test('space names are first come; an unregistered space cannot be joined', async () => {
    const s = setup()
    const thief = genSigner()
    assert.throws(() => s.gate.spaces.register({ space: SPACE, ownerPub: thief.pub, sig: sign(thief.priv, MSG.register(SPACE, thief.pub)) }), /taken/)
    const deposit = gateDepositor({ gatePub: s.gate.pub, post: async (p, b) => s.gate.deposit(b) })
    const f = await sealMessage('x', { check: 'human', space: 'nobody-owns-this' }, { deposit })
    const alice = s.reader(ALICE)
    assert.equal(await alice.open(f), null)
    assert.match(alice.log.denials.at(-1), /does not exist/)
  })
})

describe('ENS spaces (@name → name.space.lortnoctahc.eth) — ENS read faked, gate + checks real', async () => {
  const { createEnsSpaces } = await import('../../gate/ens-spaces.mjs')
  const ENS = new Map() // name → { owner, token, bans }
  const ensSpaces = createEnsSpaces({ read: async (name) => ENS.get(name) ?? { owner: null, token: null, bans: null } })

  function ensSetup() {
    const gate = createGate({ world: fakeWorld(), ensSpaces })
    const post = async (path, body) => (path === '/deposit' ? gate.deposit(body) : path === '/challenge' ? gate.challenge(body) : gate.release(body))
    const deposit = gateDepositor({ gatePub: gate.pub, post })
    const reader = (nullifier) => {
      const key = genSigner()
      const log = { member: null, denials: [] }
      const release = gateReleaser({ post, proofFor: proofFor({ response: { nullifier } }), extraFor: () => ({ memberPub: key.pub }),
        onRelease: (r) => (log.member = r.member ?? log.member), onDeny: (d) => log.denials.push(d.deny) })
      return { key, log, open: (f) => openMessage(f, { release }) }
    }
    return { gate, deposit, reader }
  }

  test('a member joins an ENS space; the ENS ban record keeps them out, and stops them signing', async () => {
    const s = ensSetup()
    ENS.set('garden.space.lortnoctahc.eth', { owner: '0x' + '11'.repeat(20), token: '', bans: '' })
    ensSpaces.forget('@garden')
    const f = await sealMessage('seeds swap sunday', { check: 'human', space: '@garden' }, { deposit: s.deposit })
    assert.match(inspect(f).checks[0], /members of garden\.space\.lortnoctahc\.eth/)
    const m = s.reader(MALLORY)
    assert.equal(await m.open(f), 'seeds swap sunday')
    const { memberId } = m.log.member
    // the owner (or a moderator) writes the ban into ENS
    ENS.set('garden.space.lortnoctahc.eth', { owner: '0x' + '11'.repeat(20), token: '', bans: `member-000000000000, ${memberId}` })
    ensSpaces.forget('@garden')
    const again = s.reader(MALLORY)
    assert.equal(await again.open(await sealMessage('next', { check: 'human', space: '@garden' }, { deposit: s.deposit })), null)
    assert.match(again.log.denials.at(-1), /banned/)
    const h = contentHash('x')
    const att = await s.gate.spaces.attest({ space: '@garden', memberId, contentHash: h, sig: sign(m.key.priv, MSG.authorRequest('@garden', memberId, h)) })
    assert.match(att.deny, /banned/)
  })

  test('an ENS space that does not exist (no registry owner) cannot be joined', async () => {
    const s = ensSetup()
    const f = await sealMessage('x', { check: 'human', space: '@nobody' }, { deposit: s.deposit })
    const r = s.reader(ALICE)
    assert.equal(await r.open(f), null)
    assert.match(r.log.denials.at(-1), /does not exist/)
  })

  test('an ENS name can never be registered as a free gate space', () => {
    const s = ensSetup()
    const k = genSigner()
    assert.throws(() => s.gate.spaces.register({ space: '@garden', ownerPub: k.pub, sig: sign(k.priv, MSG.register('@garden', k.pub)) }), /space names/)
  })
})
