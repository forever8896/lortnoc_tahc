// The `nft` check: holders of an ENS space's collection open posts; the gate's refusals are real.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../../gate/core.mjs'
import { gateDepositor, gateReleaser } from '../../shared/gateclient.mjs'
import { sealMessage, openMessage, inspect } from '../../shared/webframe.mjs'
import { genSigner } from '../../shared/member.mjs'
import { fakeChain, wallet, nftProofFor, COLLECTION } from '../lib/nft-fake.mjs'

const NAME = 'club.space.lortnoctahc.eth'
function setup() {
  const chain = fakeChain()
  chain.ens.set(NAME, { owner: '0x' + '11'.repeat(20), token: COLLECTION, bans: '' })
  const gate = createGate({ ensSpaces: chain.ensSpaces, holders: chain.holders })
  const post = async (path, body) => (path === '/deposit' ? gate.deposit(body) : path === '/challenge' ? gate.challenge(body) : gate.release(body))
  const deposit = gateDepositor({ gatePub: gate.pub, post })
  const reader = (account, opts) => {
    const key = genSigner()
    const log = { member: null, denials: [] }
    const release = gateReleaser({ post, proofFor: nftProofFor(account, opts), extraFor: () => ({ memberPub: key.pub }),
      onRelease: (r) => (log.member = r.member ?? log.member), onDeny: (d) => log.denials.push(d.deny) })
    return { log, open: (f) => openMessage(f, { release }), release }
  }
  const lock = (text) => sealMessage(text, { check: 'nft', space: '@club' }, { deposit })
  return { chain, gate, reader, lock, post }
}

describe('nft — holders of an ENS space collection', () => {
  test('a holder opens it and becomes a member; the post never names the collection', async () => {
    const s = setup()
    const alice = wallet()
    s.chain.balances.set(alice.address.toLowerCase(), 1n)
    const f = await s.lock('holders party')
    assert.match(inspect(f).checks[0], /Holders of club\.space\.lortnoctahc\.eth/)
    assert.ok(!Buffer.from(f).toString('hex').includes('00000000000000000000000000000000000000aa'), 'collection is in ENS, not the post')
    const r = s.reader(alice)
    assert.equal(await r.open(f), 'holders party')
    assert.match(r.log.member.memberId, /^member-/)
  })
  test('a wallet without the NFT is refused', async () => {
    const s = setup()
    const r = s.reader(wallet())
    assert.equal(await r.open(await s.lock('x')), null)
    assert.match(r.log.denials.at(-1), /doesn't hold/)
  })
  test("claiming someone else's wallet fails (signature from another key)", async () => {
    const s = setup()
    const holder = wallet()
    s.chain.balances.set(holder.address.toLowerCase(), 1n)
    const r = s.reader(holder, { signer: wallet() })
    assert.equal(await r.open(await s.lock('x')), null)
    assert.match(r.log.denials.at(-1), /not from that wallet/)
  })
  test('a replayed signature is refused (single-use challenge)', async () => {
    const s = setup()
    const alice = wallet()
    s.chain.balances.set(alice.address.toLowerCase(), 1n)
    const f = await s.lock('once')
    let body
    const capture = async (path, b) => ((path === '/release' ? (body = b) : 0), s.post(path, b))
    assert.equal(await openMessage(f, { release: gateReleaser({ post: capture, proofFor: nftProofFor(alice) }) }), 'once')
    assert.equal((await s.post('/release', body)).deny, 'challenge already used')
  })
  test('the ENS ban list keeps a banned holder out', async () => {
    const s = setup()
    const alice = wallet()
    s.chain.balances.set(alice.address.toLowerCase(), 1n)
    const r = s.reader(alice)
    await r.open(await s.lock('first'))
    s.chain.ens.set(NAME, { owner: '0x' + '11'.repeat(20), token: COLLECTION, bans: r.log.member.memberId })
    s.chain.ensSpaces.forget('@club')
    const again = s.reader(alice)
    assert.equal(await again.open(await s.lock('second')), null)
    assert.match(again.log.denials.at(-1), /banned/)
  })
  test('a space with no collection set says so', async () => {
    const s = setup()
    s.chain.ens.set(NAME, { owner: '0x' + '11'.repeat(20), token: '', bans: '' })
    s.chain.ensSpaces.forget('@club')
    const r = s.reader(wallet())
    assert.equal(await r.open(await s.lock('x')), null)
    assert.match(r.log.denials.at(-1), /no NFT collection/)
  })
})
